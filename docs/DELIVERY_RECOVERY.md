# Devnet delivery recovery

Backend settings (see `backend/.env.example`): `SOLANA_RPC_URL`, `SOLANA_RPC_MAX_CONCURRENT=3`,
`SOLANA_RPC_BALANCE_CACHE_TTL_MS=20000`. Keep RPC credentials out of frontend/VITE settings.
Existing Devnet network and genesis checks remain enforced. An unset RPC URL retains the public Devnet fallback.

Automatic recovery requires `APP_STORAGE=mongo` and the existing Mongo settings. Start the usual backend;
the worker loads saved delivery plans every 10 seconds, honors persisted backoff, and uses a renewable 2-minute
Mongo lease shared with manual recovery. It stops on completion or `requires_attention` (permanent failure or
30 attempts). File development storage supports manual recovery only. Paid legacy records without a delivery
plan are still shown as undelivered; they are not guessed or silently converted to demo mint plans.

RPC requests have at most four retries after the initial request, honoring Retry-After or 2/4/8/16-second
backoff plus jitter. Token balance snapshots use the configured TTL; purchase funds checks are not cached.
Unknown delivery outcomes retain signed bytes and the original mint. Expired transactions require history
and finalized creation-marker checks before replacement. Recovery never calls a payment executor.

From `backend`, verify the exact existing order (read-only):

```powershell
node --env-file-if-exists=.env --import tsx scripts/recover-nft-delivery.mts 3ymsKRrzVvqVrgsfuC9xqvbi9ggXzW7CDx7i3VgZGVh5XmtQnXF5241c5LXwUdcKUKsvsnuBoqpAyNLs6ZW8xEaQ
```

Append `--resume` to attempt delivery only, including after correcting a `requires_attention` cause.
An active worker lease or future retry time prevents concurrent execution. The script prints no signed bytes
or credentials. Success requires `phase=COMPLETED`, a delivery signature and verified recipient evidence.
The original order is `TRANSFER_NFT`; it needs custody/transfer authority over the selected NFT, not a substitute mint.

New demo mints require `NFT_DEMO_PUBLIC_URL` pointing to the publicly hosted HTTPS backend and a public HTTPS
image in their plan. The configured origin must serve `/api/acquisition/delivery-metadata/:id`. URL validation
does not deploy hosting or guarantee external availability. Existing NFT transfers keep their own metadata.


## Automatic demo NFT delivery (current flow)

Before a new purchase, accept the demo explanation in the existing Budget setup panel.
The checkbox applies to the connected wallet and resets when the wallet changes. Existing
mandate holders can also accept there without creating another mandate. The authenticated
purchase endpoint rejects a new order without demoAccepted=true, then persists demoAcceptedAt,
deliveryMode and the verified recipient before executing the existing mandate spend.

Payment confirmation enqueues an immutable delivery plan; the HTTP purchase request does not
sign a delivery transaction. DeliveryWorker processes it under the existing Mongo lease.
The saved pre-payment order also acts as a durable outbox: if the server crashes before enqueue,
the worker reconciles pending payment read-only and queues confirmed payments automatically.
This recovery path never calls the payment executor and excludes legacy modes. Temporary RPC
failures back off. New orders never show the replacement-consent button or require a post-payment
Phantom signature. Existing paid original-NFT orders keep the separate consent procedure below.

With DEVNET_DELIVERY_LIVE_ENABLED=false, plans can be queued but the worker stays stopped.
This is intentional during implementation; queued does not mean delivered.

New autonomous NFT orders persist the verified Phantom recipient before payment and use
DEVNET_DEMO_MINT. This uses Token-2022 MetadataPointer/TokenMetadata, decimals 0, supply 1,
the recipient ATA, and atomic mint-authority revocation. Original marketplace images are not
copied: public metadata references a neutral GoBuy SVG served without authentication.
Existing TRANSFER_NFT / ORIGINAL_NFT_TRANSFER plans are never automatically converted.

Live broadcast defaults to disabled. DEVNET_DELIVERY_LIVE_ENABLED=true requires explicit
operator/user approval before starting the backend. During this implementation the backend
watchers were stopped and no live payment or mint was sent. Tests use mocks and do not load .env.
Keep the flag false while inspecting configuration. The worker does not start while disabled.

Required configuration: existing agent signer and Mongo settings, SOLANA_RPC_URL (Devnet),
NFT_DEMO_PUBLIC_URL (durable public HTTPS backend origin). The configured origin must actually
serve the metadata and /api/acquisition/demo-nft-image.svg without authentication. Availability
and matching metadata are checked before preparing a new demo mint. Localhost and temporary
unreachable URLs will block delivery; configuring a URL does not deploy hosting.

### Existing paid order

Do not run a new purchase or the old --resume script to convert a legacy order.
1. Inspect the exact original payment, any external refund/settlement, deliveryCompletions,
   deliveryAttempts, and the deterministic creation marker. Never choose by amount alone.
2. Because legacy records lack a refund ledger, an operator must record recoveryReview on the
   existing autonomousPurchases value after review: status=unsettled, paymentSignature equal
   to the original payment, reviewedAt (ISO date), reviewedBy (operator identity). This is not
   exposed as a client-editable API. Missing review, refund fields or other settlement blocks recovery.
3. Connect and verify the original purchaser's Phantom wallet. Click Nh?n NFT demo thay th? in
   the purchase details, accept the explanation, then sign the order/payment/wallet-specific
   consent message. The challenge expires in five minutes. Signing is not a SOL payment.
4. The authenticated endpoint verifies consent, original Devnet payment signature and receipt,
   recipient, absence of completed or signed delivery attempts, and absence of an existing mint.
   Any ambiguous signed attempt blocks conversion for manual reconciliation. Consent and mode
   are persisted atomically on the existing plan under the same Mongo lease as the worker.
5. Only after explicit live approval, enable the flag and start the backend. The worker uses the
   existing payment and original deterministic mint; it never calls the payment executor.
6. Wait for DELIVERED / COMPLETED. Open the separate mint and delivery transaction Explorer links
   with cluster=devnet. Verify supply=1, decimals=0, revoked mint authority and the recipient ATA.
   Enable Devnet in Phantom. Wallet gallery indexing may lag or differ for Token-2022; Explorer
   and verified ATA ownership remain authoritative. Metadata availability does not prove delivery.

No live recovery or public metadata deployment has been performed by this change.

### Legacy recovery safety update

The existing replacement button signs a five-minute off-chain message naming the account,
order, original payment, recipient, DEVNET_DEMO_MINT mode and nonce. Acceptance checks the
payment again under the delivery lease. MongoDB consumes the nonce and updates the existing
autonomousPurchases and deliveryPlans documents in one transaction. A replay is rejected;
if the HTTP response is lost, read status instead of signing or paying again. No purchase is
created and no mandate counter is written. MongoDB must support transactions (replica set or
sharded cluster); a standalone server is a blocker, with no non-atomic fallback.

An operator settlement review is required for every legacy replacement. No production review,
order conversion, blockchain broadcast or worker startup was performed during implementation.
The displayed approval and mint-pending states are separate from verified delivery success.

### Public metadata deployment

### Local Quick Tunnel testing (no Render)

Run `node backend/scripts/metadata-proxy.mjs` from the repository root. It binds only
127.0.0.1:3002 and forwards exact GET metadata/image paths to 127.0.0.1:3001. All other
paths and methods return 404; credentials and arbitrary headers are never forwarded.
Run `.cache/tunnel/cloudflared.exe tunnel --url http://127.0.0.1:3002 --no-autoupdate`.
Set LOCAL backend/.env NFT_DEMO_PUBLIC_URL to the printed HTTPS trycloudflare.com origin.
The proxy reloads that origin for metadata image URLs and adds the demo Type label for
legacy metadata, without modifying MongoDB. Never tunnel directly to the full backend.

Keep DEVNET_DELIVERY_LIVE_ENABLED=false. A backend process started before the .env edit
must be restarted to load the new origin before any separately approved delivery run.
Metadata URI is built from this configuration and the existing plan metadataId when preparing
the mint; payment and consent are untouched. Keep the same tunnel alive while testing:
Quick Tunnel URLs are temporary and restarting cloudflared can change the URL. Already minted
URIs do not automatically follow later .env changes. This is not persistent NFT hosting.
Logs/binary are under ignored .cache/tunnel. Stop only the proxy and cloudflared processes
you started when finished; do not enable a delivery worker as part of tunnel setup.

### Hosted backend alternative

Public demo GET routes are registered in app.ts before the authenticated acquisition router.
Only GET /api/acquisition/delivery-metadata/:id (64 lowercase hex characters) and
GET /api/acquisition/demo-nft-image.svg use this public router. Other methods fall through to
authentication. Purchase, recovery, mandate and delivery-status authorization remain unchanged.
The existing legacy /metadata/:id route retains its prior behavior.

The inspected Render deployment returned GoBuy's login-required JSON for the image while
/api/health returned 200. Local source already had public handlers before auth, so the exact
deployed revision must be checked; the observed 401 is consistent with an older deployment
falling through to authenticated routes, not evidence that Firebase should be disabled.

Deploy the updated backend using the existing build pipeline (npm run build -w @gobuy/backend).
Keep DEVNET_DELIVERY_LIVE_ENABLED=false in the hosting environment and NFT_DEMO_PUBLIC_URL
set to the durable HTTPS backend origin (no /api suffix). No database migration is needed.
After deployment, GET the image and an existing metadata ID without cookies or Authorization:
expect 200 image/svg+xml and 200 application/json respectively. Missing metadata must return
404, never fabricated metadata. Verify the JSON image URL also returns 200 without authentication.
Unauthenticated POST to autonomous-spend, demo-consent, demo-recovery and mandate submit must
still return 401. This code change does not publish the deployment or enable delivery.
