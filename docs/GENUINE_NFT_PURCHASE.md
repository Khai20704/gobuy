# Genuine NFT Purchase (Na Vault -> Tensor -> owner wallet)

Replaces the DEMO NFT fallback for **new** orders. Na buys the real Tensor Devnet listing and the
original NFT is delivered straight to the owner's Phantom wallet. No GoBuy DEMO NFT is minted, and no
separate settlement transfer happens before the purchase.

## Flow

1. **Owner authorizes** — Phantom signs one transaction creating an `NftPurchaseAuthorization` PDA
   (seeds `["nft-auth", mandate]`). It carries the executor, the ceiling, the expiry and the
   marketplace. This is the only signature the owner gives.
2. **Na discovers** — the existing Tensor Devnet provider finds a valid public SOL listing. SEARCH
   never spends; only a BUY request with a budget authorizes spending.
3. **Agent executes** — the Na Agent keypair is fee payer and sole outer signer. The Vault PDA is the
   Tensor `payer`, signed inside the program via `invoke_signed` on `["vault", mandate]`.
4. **Program asserts, then CPI** — `buy_nft_from_mandate` loads the mandate and the purchase
   authorization, validates executor/owner/mint/price/budget/expiry, then performs the BuyLegacy CPI.
5. **Delivery** — Tensor transfers the original mint to the owner's ATA in the same instruction. An
   `NftPurchaseReceipt` PDA (seeds `["purchase", mandate, order_id]`) records the order, so a replay
   can never buy twice.

## Roles

| Role | Key | Purpose |
| --- | --- | --- |
| Fee payer / executor | Na Agent keypair | Signs and pays; must equal `mandate.executor` |
| Payer | Vault PDA | The Tensor BuyLegacy `payer`; signs via `invoke_signed` |
| Buyer / NFT recipient | `mandate.owner` | Tensor `buyer`, and the ATA that receives the NFT |
| Destination ATA | owner's classic SPL ATA | Created if absent, funded by the agent |

## Verified Tensor layout

- Marketplace program: `TCMPhJdwDryooaGtiocG1u3xcYbRpiJzb283XfCZsDp` (fixed, asserted).
- BuyLegacy discriminator `447f2b08d41ff972`; data = discriminator(8) + `maxAmount` u64 LE(8) + two
  `None` optionals(2) = **18 bytes**.
- Exactly **24 accounts**; `payer` at index 7 is the only signer. Absent optionals are passed as the
  marketplace program id sentinel.
- `assertTensorBuyLegacyInstruction` re-checks payer, buyer, buyer ATA, mint, list state, seller,
  price, discriminator, data length and account count before anything is signed.

## Supported surface (v1)

Solana Devnet, Tensor `BuyLegacy`, classic SPL Token + Metaplex NonFungible, public SOL listings, no
cosigner and no private-taker restriction. Anything else is refused rather than attempted.

## Safety invariants

- **No arbitrary CPI.** The instruction takes the 24 Tensor accounts in fixed roles, ensures the
  marketplace program id matches the constant, and strips signer privilege from every account.
- **No settlement transfer.** The vault pays Tensor directly; there is no pre-purchase transfer.
- **Atomic.** Payment and NFT transfer are one instruction, so no partial state is observable.
- **Replay-proof.** The receipt PDA derives from a stable order id, so a second attempt fails.
- **Fail-closed reads.** A tampered or truncated authorization/receipt account throws; it is never
  partially decoded and shown to the owner as an approval.
- **Ceiling above price.** `maxAllowedDebit` adds a margin for fees and ATA rent.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `NFT_PURCHASE_LIVE_ENABLED` | `false` | Must be exactly `true` for `/purchase` to broadcast |
| `GOBUY_DEMO_AUTOPURCHASE_ENABLED` | `false` | Legacy DEMO flow; new orders refused unless `true` |
| `NA_PROGRAM_ID` | — | Na Vault program id (`CHjdqooB7TrussJoZoboFP5TtdCspoHtvPpqoshbr5zE` on Devnet) |

With live execution off, discovery, quotes, the authorization read and `/config` all still work; only
the broadcast is refused. That is the default and the safe state.

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/nft-purchases/config` | Network, marketplace, delivery mode, live flag |
| `GET` | `/api/nft-purchases/authorization?owner=` | Read the owner's on-chain authorization |
| `POST` | `/api/nft-purchases/authorization` | Build the owner-signed approval transaction |
| `POST` | `/api/nft-purchases/authorization/submit` | Submit the owner-signed approval |
| `POST` | `/api/nft-purchases/purchase` | Buy a listing from a saved BUY discovery |
| `GET` | `/api/nft-purchases/purchases/:discoveryId` | Status of one order |

`/purchase` requires a saved discovery that belongs to the caller, has not expired, and was a **BUY**
(`priceDiscoveryOnly` is refused). A SEARCH result carries no spending authority.

## DEMO removal

`AutonomousPurchaseService.execute` refuses a **new** order unless `GOBUY_DEMO_AUTOPURCHASE_ENABLED`
is `true`. Orders already persisted keep reconciling through `status`/`recoverMissing`, so an
in-flight attempt is never orphaned — the gate only prevents starting a new DEMO purchase.

## Verification status and blocker

Verified locally:

- Backend type-check passes (`tsc -p backend/tsconfig.json --noEmit`, exit 0).
- `backend/tests/nftPurchase.test.ts` — 13/13, covering order identity, budget arithmetic, every
  authorization rejection, fail-closed decoding of the authorization and receipt accounts, the
  verified 24-account BuyLegacy shape, rejection of a swapped payer / changed price / short account
  list / extra payload, both instruction encodings, and the live/DEMO default gates.

**Blocker — the Anchor program cannot be compiled or deployed in this environment.** `cargo build`
fails because the MSVC `link.exe` is missing, and neither the Anchor CLI nor the Solana CLI is
installed (no WSL either). `cargo check` cannot link either. The Rust changes in
`anchor/programs/gobuy_na/src/nft_purchase.rs`, `nft_purchase_rules.rs` and `lib.rs` are therefore
**unverified by compilation**, and no CPI has been exercised on chain. The TypeScript side is verified
against static fixtures derived from the installed `@tensor-foundation/marketplace` SDK, not against a
live Devnet transaction.

Before enabling `NFT_PURCHASE_LIVE_ENABLED=true`: build the program with a working Anchor toolchain,
deploy to Devnet, then run one purchase end to end and confirm the receipt PDA and the NFT's presence
in the owner's ATA.
