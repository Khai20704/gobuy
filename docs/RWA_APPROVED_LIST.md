# RWA approved identities

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
source before inserting a document with `verified: true` and `allowedForSwap: true`.
The URL is evidence recorded for review, not automatic proof of authenticity.
The agent and public HTTP API have no registry write operation. Restrict collection
writes to operators using database permissions. Revoke by setting either flag false
or removing the document. Every discovery reloads the list; no restart is required.
Missing, malformed, unavailable or empty registries fail closed. Reviews older than
30 days must be renewed against issuer evidence. No real assets are seeded implicitly.

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
discovery. Resolution order: exact approved mint → RWA-shaped but not approved (blocked)
→ verified NFT evidence → unknown. A symbol-shaped token carrying a spend
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
pass again. Only then could execution be attempted — and it cannot be, because the
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
  asset; a QUANTITY order values the exact quantity it wants (asset → USDC) so the ceiling is
  compared against the real cost of that quantity. Quoting a QUANTITY order as a SOL spend
  would answer a different question than the one asked.
* `otherAmountThreshold` is only accepted when it is at least
  `floor(outAmount * (10000 - slippageBps) / 10000)`. Comparing
  `threshold * 10000 >= outAmount * (10000 - slippageBps)` is stricter than Jupiter's floor
  and rejects valid quotes whose product is not divisible by 10000.
