# Na asset acquisition

## Active NFT path

```text
Na chat
→ /api/acquisition/discover
→ NFTIntentParser
→ Tensor Devnet on-chain listings
→ Helius DAS/RPC asset and owner verification
→ deterministic NFT ranking
→ signed backend spending-policy check
→ Tensor Marketplace buy instruction
→ unsigned quote for Phantom
→ signed transaction revalidation and Devnet submission
→ confirmed receipt and chain ownership check
```

`Tìm tranh NFT dưới 1 SOL` only discovers and ranks; it never requests a transaction.
An explicit `Mua ...` request selects a candidate without asking the user to pick one,
but still requires a valid NFT spending policy and a separate Phantom signature for the
specific transaction. The LLM may help interpret search language; it cannot create
Tensor instructions, alter the explicit SOL budget, or authorize spending.

The Tensor adapter uses `@tensor-foundation/marketplace` to decode the deployed
Marketplace Program's Devnet listing state and build the purchase instruction. It does
not use a hosted Tensor REST API, and **Tensor requires no API key** for this direct
on-chain integration. Helius is the asset/RPC provider, not the marketplace: its backend
client uses Devnet `getGenesisHash` and DAS `getAsset`; current seller ownership is
cross-checked with `getTokenAccountsByOwner`. Helius does not provide Tensor prices,
listings, volume or buy instructions.

The server-only `HELIUS_API_KEY` must be set in `backend/.env`. Do not put it in root or
frontend environment files, prefix it with `VITE_`, or print it in logs. Helius reports
only Devnet configuration. The active NFT flow fails closed on a missing key, Helius
outage, malformed asset, owner mismatch or wrong network; it does not synthesize NFT
metadata. `GET /api/acquisition/config` exposes a boolean `heliusConfigured` only.

The `MagicEdenProvider` is retained solely for the separate legacy `/api/research`
commerce-search integration. It is not imported by NFT discovery, ranking, quote,
submission or status; no `MAGIC_EDEN_*` setting is required by the active NFT path.

## Configuration

Use `backend/.env.example` as the server-side template:

```dotenv
HELIUS_API_KEY=
HELIUS_NETWORK=devnet
SOLANA_NETWORK=devnet
SOLANA_RPC_URL=https://api.devnet.solana.com
SOLANA_EXECUTION_NETWORK=devnet
NFT_MARKETPLACE_PROVIDER=tensor
NFT_ASSET_PROVIDER=helius
DISCOVERY_NETWORK=devnet
DEMO_MODE=true
```

Startup validates Devnet-only configuration. The executor verifies the RPC genesis
hash during preparation and again immediately before submission. Mainnet execution is
not supported; there is no silent network fallback.

## Ranking and execution checks

Tensor candidates are scored only with available evidence: metadata relevance (30%),
price fit (30%), verified ownership (10%), rarity (20%) and listing freshness (10%).
Missing signals are omitted and the remaining weights are normalized. Collection sales,
floor, liquidity and rarity distribution are not invented from listing counts. The
selection is not an investment recommendation.

The explicit maximum budget filters listings before ranking and is checked again before
preparing the transaction. Immediately before submission GoBuy checks the network,
refreshes the Tensor listing, verifies unchanged mint/seller/price, rechecks Helius
ownership and validates the exact signed transaction against the stored quote. The buy
instruction caps the price at the observed listing price; expected total spend includes
fees and must fit within the user's budget and wallet balance. A purchase is only
reported after a successful confirmed transaction and verification that the NFT is in
the buyer's wallet.

The signed spending policy is an authenticated backend policy, not an on-chain delegate.
It checks wallet, Devnet, NFT category, expiry, revocation, total/per-transaction/daily
limits and allowed mints; spending is reserved before quote creation and rechecked before
submission. Revoking the policy blocks a not-yet-submitted purchase. The Anchor program
currently has an undeployed sentinel ID and does not hold funds or execute Tensor buys.
Thus this is **not autonomous execution**: Phantom must approve every purchase.

## Verification and limitations

Run from the repository root:

```sh
npm test
npm run lint
npm run build
```

Tests use mocks/fixtures for Helius and Tensor behavior. They verify typed Helius errors,
metadata and ownership checks, discovery, budget and network filters, stale/changed
listings, instruction conversion, intent parsing, policy enforcement and failure
handling. These tests are not proof of live Helius availability or a completed
marketplace purchase.

Devnet support is intentionally limited to supported public native-SOL Tensor listings
and verified Metaplex NFT metadata/mint standards. Unsupported token programs, expired
or private listings, missing/mismatched metadata and unsupported NFT standards are
excluded. The latest confirmed implementation check did not include a user Phantom
signature, a submitted transaction or an NFT transfer; no purchase is claimed.
Use a funded Phantom Devnet wallet only if you choose to test a real transaction.

For current SDK evidence, code paths and implementation history, see
[NFT_BUY_IMPLEMENTATION.md](./NFT_BUY_IMPLEMENTATION.md). For application policy and
revocation details, see [DELEGATED_SPENDING.md](./DELEGATED_SPENDING.md).
