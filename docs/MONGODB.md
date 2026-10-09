# Firebase identity, MongoDB application storage, Solana Devnet

Firebase still handles Google/email/password sign-in, phone linking, token revocation and disabled accounts. The backend verifies the ID token with Firebase Admin and derives the UID and current phone from Firebase. `users.firebaseUid` is the application identity; MongoDB cannot grant phone verification or onboarding completion. The API still returns the existing profile shape and computes `ready` from the current Firebase phone and saved validated address. Region remains optional.

MongoDB is backend-only. Solana remains authoritative for transaction results and NFT ownership; Phantom still signs. Public NFT metadata/art routes remain public. No frontend Mongo driver, database URI, password, OTP, Firebase token, wallet secret or seed phrase is stored in MongoDB.

## Atlas setup

1. Create an Atlas project and cluster. Create a **database user**, distinct from your Atlas login, with read/write privileges scoped to the application database.
2. Add the backend's outbound IP (or your development IP) to the project's Network Access list. Use a restricted list rather than opening all IPs.
3. Select **Connect → Drivers → Node.js**, copy the connection string, replace the username/password placeholders and URL-encode special characters in credentials.
4. Put these values only in `backend/.env`, which is ignored by Git:

```dotenv
APP_STORAGE=mongo
MONGODB_URI=mongodb+srv://<database-user>:<encoded-password>@<cluster>/?retryWrites=true&w=majority
MONGODB_DB_NAME=gobuy
FIREBASE_PROJECT_ID=<existing-firebase-project>
GOOGLE_APPLICATION_CREDENTIALS=C:/private/firebase-admin.json
```

Official instructions: https://www.mongodb.com/docs/atlas/connect-to-database-deployment/

From the repository's `gobuy` directory:

```powershell
npm install
npm run dev
npm test
npm run lint
npm run build
```

Mongo is the default. On initialization failure the backend still listens in degraded mode and retries Mongo initialization on later requests; there is no automatic file fallback. `/api/health` only proves that HTTP is alive, not that Mongo is connected. Database-unavailable requests return 503. A shared pool is initialized once and closed after HTTP shutdown. `APP_STORAGE=file` is an explicit development/test option and is rejected with `NODE_ENV=production`.

Run `npm run check:mongo -w backend` from `gobuy` for a read-only connection/ping check using `backend/.env`. It does not create indexes or read application documents. Initialization logs now distinguish the `connect` and `indexes` stages and report safe categories (TLS, DNS, authentication, permissions, index conflict) without printing driver messages or credentials. A TLS failure occurs before database authentication; check the current outbound IP in Atlas Network Access first, then cluster availability and VPN/TLS inspection. Do not disable certificate verification to work around it.

## SRV resolution failures (EBADRESP)

`mongodb+srv://` requires an SRV lookup (`_mongodb._tcp.<cluster>`) before the driver contacts any host. Some networks — notably ISP resolvers that intercept port 53 — answer that query with a malformed packet, which c-ares reports as `EBADRESP`. The driver then fails during `connect` and never reaches Atlas at all. This is a resolver problem, not an Atlas, credentials or IP Access List problem, and it can appear after a network, router or VPN change even though it worked before. The log category is now `DNS_FAILED`; it was previously reported as `UNKNOWN`.

When the first attempt fails with a resolver error on a `mongodb+srv://` URI, the backend resolves the SRV and TXT records over **DNS-over-HTTPS** (Cloudflare, then Google), rebuilds the URI as a direct `mongodb://` seed list including the `authSource`/`replicaSet` options published in the cluster TXT record, enables TLS and retries once. Ordinary A/AAAA resolution and the driver's own SRV path are unchanged, so a healthy network pays nothing extra. Only resolver errors (`EBADRESP`, `ENOTFOUND`, `EAI_AGAIN`, `ESERVFAIL`, `ENODATA`, `ETIMEOUT`, `EREFUSED`, `EFORMERR`, `ENOTIMP`) trigger the retry: authentication, TLS, IP allow list and index failures never do, and the retry never runs for a plain `mongodb://` URI.

```dotenv
# Disable the retry (leave the system resolver as the only path):
MONGODB_SRV_DOH_FALLBACK=false
# Custom JSON DoH endpoints, comma-separated. Default: Cloudflare then Google.
MONGODB_SRV_DOH_URL=https://cloudflare-dns.com/dns-query
```

Diagnose with `npm run check:mongo -w backend`. It uses the same connection path as the API and prints `MongoDB connection and ping succeeded.` when the fallback recovered; a `srv-fallback` line before that is expected and harmless. If DNS-over-HTTPS is blocked as well, copy the direct connection string from Atlas (Connect → Drivers, the `mongodb://` variant listing `<shard>.mongodb.net:27017` seed hosts) into `MONGODB_URI`; that bypasses SRV entirely. Never widen the Atlas IP Access List or disable certificate verification to compensate — `EBADRESP` is decided before authentication and before any server is selected.

## Collections and indexes

| Collection | Contents | Unique index |
| --- | --- | --- |
| `users` | `firebaseUid`, last observed email/phone, embedded validated `address`, creation/update dates | `firebaseUid` |
| `orders` | `orderId`, immutable `ownerUid`, existing quote/text, submitted transaction/signature, dates | `orderId` |
| `commerceTwins` | Existing anonymous session hash, validated preferences/history/actions, concurrency revision | `session` |

Order lookups currently use order ID, so no speculative owner/date indexes are created. Add a compound owner/date index when a listing API needs it. Order submission uses an atomic owner-filtered conditional update; no overwrite of an existing owner/quote is permitted. Ownerless legacy records are not assigned to authenticated callers. Signed Solana wire transactions are retained as in the previous implementation; they are not private keys or Firebase credentials.

`ProfileStore`, `OrderStore` and `TwinStore` keep database calls outside routes. Delivery data is embedded in `users`; no unused conversations/transactions collections are introduced. Commerce Twin remains scoped to its existing anonymous cookie/session hash, never relabeled as a Firebase UID. Extension pairing/session maps and proposal/demo memory state remain ephemeral as before.

The existing demo seller keypair file remains local and is never imported into MongoDB. It is not a Phantom key. Keep the backend's `.data/nft-demo` directory durable and private, as before. This migration does not make that demo seller provisioning suitable for independent multi-host deployments.

## Emulator and isolated tests

```powershell
npm run dev:auth
```

The launcher explicitly chooses `APP_STORAGE=file` for its credential-free default, with separate account/order/Twin emulator directories. To use Mongo with the Auth Emulator instead:

```powershell
$env:APP_STORAGE='mongo'
$env:MONGODB_DB_NAME='gobuy_emulator'
npm run dev:auth
```

Set `MONGODB_URI` in `backend/.env` (or the shell). The database user must have access to the emulator database too. Mongo startup rejects emulator use unless the database name ends in `_emulator`. Remove the shell overrides when returning to real Firebase. Emulator identities normally disappear on restart; persisted profiles do not authenticate those identities.

Unit/API tests use injected file stores and a driver-boundary fake, and never need personal Atlas credentials. The fake verifies query/update contracts but is not a Mongo server integration test. For browser tests, start Auth Emulator on 9099, then run `npx playwright test --config playwright.auth.config.ts`; this config explicitly uses file storage. Real Atlas connectivity, Google OAuth and real SMS still need deployment credentials and manual verification.

## Safe one-time import

Stop the app before importing so old file writes and new Mongo writes cannot diverge. Preserve backups. Commands below run from `gobuy`; source directory arguments are relative to `backend` because this is a workspace script.

```powershell
# Validate and count only; reads Firebase users, does not write MongoDB.
npm run migrate:accounts:mongo
# Import profiles, keeping original JSON files.
npm run migrate:accounts:mongo -- --apply
# Optional import of old NFT orders and anonymous Commerce Twins too.
npm run migrate:accounts:mongo -- --apply --orders-dir .data/nft-demo --twins-dir .data/commerce-twins
# Alternate profile directory (requires matching Firebase project/emulator).
npm run migrate:accounts:mongo -- --accounts-dir .data/accounts-emulator
```

The old account JSON contains only address fields; filenames are SHA-256 UID hashes. The importer lists Firebase users via Admin, hashes their UIDs and matches filenames. It never guesses a UID. Unknown/deleted users and unrecognized filenames are skipped; invalid known profiles count as failed. Accounts from a stopped emulator cannot be mapped unless those same emulator UIDs are restored. Original file birth/modified timestamps are used because the legacy schema contains no dates.

Imports only fill absent addresses; they never overwrite an existing Mongo address. Order/Twin imports are insert-only, do not alter owners and skip existing IDs. A seller keypair filename cannot match the order import pattern. Each collection reports migrated/skipped/failed/wouldMigrate totals without logging private profile contents. Dry-run is the default; partial failures return a nonzero exit code, and reruns are idempotent. No original file is deleted. After confirming the imported counts and a login/address reload, restart with `APP_STORAGE=mongo`.

## Implementation inventory

New backend files: `persistence/mongo.ts`, `MongoProfileStore.ts`, `OrderStore.ts`, `MongoTwinStore.ts`, `migrateProfiles.ts`, `scripts/migrateMongo.ts`; tests: `backend/tests/mongoPersistence.test.ts`.

Integration changes: `backend/src/auth/accounts.ts`, `services/nftDemo/NftDemoService.ts`, `services/twin/TwinStore.ts`, `application/createResearchService.ts`, `server.ts`; package manifests/lockfile; backend environment example; `scripts/dev-auth.mjs`; Playwright configs and the account browser test (removed obsolete region input); root README and account docs. Added dependency: official `mongodb` driver in backend only.

New storage variables: `APP_STORAGE`, `MONGODB_URI`, `MONGODB_DB_NAME`; optional `NFT_DATA_DIR` selects the existing local demo seller/files directory. Existing `ACCOUNT_DATA_DIR` and `TWIN_DATA_DIR` apply to explicit file mode/migration. No `VITE_MONGODB_*` variables are used.
