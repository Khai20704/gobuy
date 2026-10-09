# RWA approved identities

## Multi-chain demo catalog

The existing `mint` field is retained as the canonical storage key for compatibility.
Solana keys remain base58; EVM keys are `<chain>:<lowercase 0x address>`.
Supported issuer network mappings: Ethereum, Base, Arbitrum, BinanceSmartChain,
Polygon, Avalanche, Gnosis, Mantle and Ink. Unknown networks are not imported.
The chain-qualified key keeps the existing unique index and separates equal
addresses on different chains. Existing Solana history does not need migration.

`sync-rwa.mts` now collects these EVM deployments from the same xStocks issuer API.
EVM identity comes from the issuer deployment, without Solana RPC or guessed
decimals. Existing Solana deployment checks are retained. Mixed catalogs still
finish all checks before writes; a Solana RPC failure aborts the whole sync.
Use the usual dry run, then `--apply` to populate the database.

Example request: `Buy RWA ethereum:0x<40 hex characters> 100 USDC`.
Duplicate approved symbols require an explicit deployment identity. An approved
EVM deployment gets an exact-chain/address Dex Screener reference price (median
of available base-token pool prices). Missing prices prevent demo selection.
Quantities are estimates, not swap quotes. USD/SOL conversion alone uses Jupiter;
foreign-chain addresses are never submitted to Jupiter for token swaps.
Only Devnet SOL is spent through the existing Vault demo; request history records
the deployment and Devnet transaction. No token is delivered on another chain.
Conditional/quantity orders for EVM assets are currently unavailable.

Approval freshness, administrator revocations and wallet eligibility are checked
again before a new demo spend. Dex Screener never writes or grants approval.

`RWA_APPROVED_LIST` is a MongoDB collection in the configured application database.
Its only purpose is to prevent Na from selecting counterfeit or incorrect RWA mints.
Approval is an administrator's attestation of asset identity, not an investment rating.
Liquidity, volume, popularity and Jupiter availability cannot grant approval.

Each document contains `mint`, `symbol`, `name`, `issuer`, `category`, `underlying`,
`decimals`, `verified`, `allowedForSwap`, `verificationSource` (issuer HTTPS source),
and `updatedAt` (ISO timestamp). Optional `eligibleWallets` enforces issuer wallet
restrictions separately from identity. Optional `network` (`mainnet` | `devnet`) is
absent for existing documents and is read as `mainnet`. MongoDB `_id` is permitted;
other fields outside the schema are rejected. Categories: GOLD, TREASURY, EQUITY, ETF,
COMMODITY, OTHER. Mints have a unique index and refer exclusively to Solana mainnet.

An administrator must independently check the mint against the issuer's official
source, or enable the explicit issuer synchronization worker described below, before
inserting a document with `verified: true` and `allowedForSwap: true`.
The URL is evidence recorded for review, not automatic proof of authenticity.
The agent and public HTTP API have no registry write operation. Restrict collection
writes to operators using database permissions. Revoke by setting either flag false
or removing the document. Every discovery reloads the list; no restart is required.
Missing, malformed, unavailable or empty registries fail closed. Reviews older than
30 days must be renewed against issuer evidence. No real assets are seeded implicitly.

## Issuer synchronization worker (xStocks)

`backend/scripts/sync-rwa.mts` fetches only the fixed official endpoint
`https://api.xstocks.fi/api/v2/public/assets`, follows zero-indexed pagination, and
checks every Solana mint against mainnet SPL/Token-2022 account data. Jupiter never
grants approval. Source documentation:
https://docs.xstocks.fi/apis/openapi/assets/list_public_assets

**Rollout status:** the operator-supplied API response confirms deployment fields
`network`, `address` and production network label `Solana`; these are now defaults.
It also shows `underlying.type: null`, which is retained as category `OTHER`, not
guessed as equity or technology. A complete live dry run with on-chain verification
is still required before applying. The supplied excerpt starts mid-document and is
not used as an approval snapshot. No production database has been updated.

Read the public response first (no database writes):

```powershell
node --import tsx backend/scripts/sync-rwa.mts --inspect
```

Run a full dry run with the verified default field mapping:

```powershell
node --env-file-if-exists=backend/.env --import tsx backend/scripts/sync-rwa.mts
```

The optional `--network-field`, `--mint-field`, `--solana-network` overrides are for
reviewed API schema changes, not hand-entered token lists. Mint decimals come from
the on-chain mint account, never the nested `stablecoins[].decimals` values.
Unknown fields/types, duplicate identities, empty snapshots, pagination errors,
on-chain verification failures and more than `RWA_REGISTRY_CAPACITY` (currently 50,000)
merged deployments abort the run. The cap counts deployments, not issuer assets, because
one issuer asset may be deployed on several chains.

Default mode prints a dry-run report. Add `--apply` only after review. Add `--watch`
with `--apply` to repeat hourly. This is an operator process, not a chat endpoint;
no deployment configuration or production database has been modified automatically.

New rows carry `syncSource: "xstocks-v2"`. Existing manual rows stay unchanged.
Managed rows absent from a complete successful snapshot are disabled. Revocations
and `eligibleWallets` restrictions are never automatically relaxed; an operator must
review re-enablement. Mongo updates use optimistic matching to preserve concurrent
edits; the file store requires a single writer. A failure during writes may leave
some verified rows refreshed; reruns are idempotent.

Optional `sector` stores source/reviewer metadata. Missing sector data is not invented;
existing category keyword matching remains a limited fallback for older rows.
The issuer adapter currently covers backed equities/ETFs only, not every RWA issuer.

Ranking now uses valid budget quotes and Jupiter price impact when supplied, never
lower unit price as an investment score. Missing impact adds no quality points. Ties
use symbol order and are disclosed. A single matching asset is explicitly described
as one candidate, not the winner of a market-wide comparison.

With `APP_STORAGE=file` (development/tests only), set `RWA_APPROVED_LIST_PATH` to
a JSON array of the same documents without `_id`. Legacy `RWA_REGISTRY_PATH` remains
an alias. Mongo mode never falls back to the file. Paths are relative to the backend
working directory when using npm workspace scripts.

Na resolves exactly one approved identity, verifies its on-chain SPL mint and decimals,
then requests Jupiter Swap API V2 `/order` using that canonical output mint. It rejects
responses with different input/output mints, amount or slippage bounds. Lack of a route
means no quote; it does not revoke identity approval or select a replacement token.
Configure server-only `JUPITER_API_KEY` and `RWA_SOLANA_RPC_URL` for those calls.

Current RWA routes remain mainnet quote-only (`executionEnabled: false`). The existing
Na Vault mandate executes on devnet and does not authorize mainnet RWA swaps. Before
adding execution, re-read approval at prepare and submission time and bind the actual
transaction's output mint to that approval; validate spend authority independently.
Registry approval alone must never authorize spending.

Jupiter reference: https://developers.jup.ag/docs/swap/order-and-execute

## Routing and conditional orders

`POST /api/investment/asset/resolve` is the single authority for "is this an RWA or an
NFT?". It returns `assetType` (`RWA` | `NFT` | `UNKNOWN`), `reason`, `symbol`, `mint` and
`blocked`. The frontend asks this endpoint instead of keeping a keyword list, so an asset
Na has never heard of (for example a new xStock) cannot be silently routed into NFT
discovery. Resolution order: exact approved mint â†’ RWA-shaped but not approved (blocked)
â†’ verified NFT evidence â†’ unknown. A symbol-shaped token carrying a spend
(`USDC`/`USD`/`$`/`SOL`) is treated as an RWA attempt and blocked; it never falls through
to the NFT flow. An intent that names neither a symbol nor a mint resolves to nothing.

Conditional orders (`POST /api/investment/rwa/discover`,
`GET /api/investment/rwa/orders`, `GET /api/investment/rwa/orders/:id`,
`POST /api/investment/rwa/orders/:id/evaluate`) support two order types that are never
interchangeable: a spend ("100 USDC of NVDAx below $175") and an exact quantity with a
cost ceiling ("1 NVDAx under 1 SOL"). Both may carry a `PRICE_BELOW` condition observed
through a USDC quote, which is market data only and never authenticity evidence.

States: `WAITING_FOR_PRICE`, `EXECUTING`, `CONFIRMED`, `FAILED`, `EXPIRED`, `CANCELLED`,
`EXECUTION_UNAVAILABLE`. An unmet price waits rather than failing. Orders are keyed by a
deterministic idempotency hash of owner, mint, order type, amount, quantity, target and
ceiling, so the same instruction is never stored or executed twice, and every order
carries a TTL after which it expires.

Identity is still re-read at the moment a condition is met: approved mint, on-chain mint
and decimals, owner mandate state, category (`RWA`/`ANY`) and remaining budget must all
pass again. Only then could execution be attempted â€” and it cannot be, because the
Anchor program has no Jupiter CPI, so an eligible order is reported as
`EXECUTION_UNAVAILABLE` with reason `ANCHOR_JUPITER_EXECUTION_REQUIRED`. No code path
fabricates a fill, a transfer, a signature or a `CONFIRMED` status.
## Operator approval procedure

Approving one identity is a deliberate, auditable action:

```
tsx --env-file-if-exists=backend/.env backend/scripts/approve-rwa.mts            # dry run, verifies on chain only
tsx --env-file-if-exists=backend/.env backend/scripts/approve-rwa.mts --confirm   # upserts the row
```

`approve-rwa.mts` refuses to write unless the RPC reports the mainnet genesis hash, the
mint exists, its owner is an SPL Token or Token-2022 program, `isInitialized` is true and
the on-chain decimals equal the recorded ones. It upserts on `mint`, so re-running updates
one row instead of duplicating it, and it creates the unique index. The script is an
operator tool: it lives in `scripts/`, is never imported by the runtime and is not exposed
over HTTP, so the agent still cannot approve anything by itself.

An empty registry is an operator gap, not an authenticity verdict. When the list has no
rows, classification reports `registry_empty` and Na says the approval data is missing
rather than implying the requested asset was judged counterfeit. A symbol that is present
but not approved reports `symbol_not_approved`; a look-alike mint for a known symbol
reports `unapproved_symbol`.

A request that names an approved symbol together with an explicit mint that is not that
symbol's canonical mint is a substitution attempt. `discover` rejects it outright before
any market lookup and never falls back to Dex Screener reference prices for the
substituted mint. Reference prices remain available only when no approved identity
contradicts the requested mint.

### NVDAx

The genuine Backed xStock is
`Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh` (Token-2022, 8 decimals, issuer
"Backed Assets (xStocks)"). It is verified on chain by the script above. This is exactly
why approval is keyed by mint and not by symbol: a Jupiter symbol search for "NVDAx"
returns around twenty tokens carrying that symbol, and every one except this mint is an
unrelated 1-3 holder pump.fun or stonkfun imitation with a price near $0.0000034.

## Request flow notes

* `verify` compares the RPC genesis hash against the full mainnet-beta base58 hash
  `5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d`. A truncated constant makes every mainnet
  RPC look like devnet, and then every approved asset is refused with a misleading
  "must be verified on mainnet" error, so the constant is imported rather than copied and
  the tests read it from the module.
* A stored order is bound to an owner wallet, so a conditional order without a connected
  owner is refused with an explicit message instead of a generic failure.
* The two order types quote in opposite directions. A SPEND order prices its money into the
  asset; a QUANTITY order values the exact quantity it wants (asset â†’ USDC) so the ceiling is
  compared against the real cost of that quantity. Quoting a QUANTITY order as a SOL spend
  would answer a different question than the one asked.
* `otherAmountThreshold` is only accepted when it is at least
  `floor(outAmount * (10000 - slippageBps) / 10000)`. Comparing
  `threshold * 10000 >= outAmount * (10000 - slippageBps)` is stricter than Jupiter's floor
  and rejects valid quotes whose product is not divisible by 10000.
