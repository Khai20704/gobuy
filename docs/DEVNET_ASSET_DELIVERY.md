# Devnet asset delivery

Discovery, identity verification, pricing, signed mandates and Anchor SOL payment remain in their existing services. Delivery runs after a confirmed payment and keeps its own signed transaction and signature. `CONFIRMED` in the payment record does not mean purchase completion. API replies add `phase`:

`PAYMENT_PENDING → PAYMENT_CONFIRMED → DELIVERY_PENDING → DELIVERY_CONFIRMED → COMPLETED`

Delivery errors use `DELIVERY_FAILED`. Chat retains the original pending purchase ID; its existing status action retries delivery without a new payment. RWA stores the confirmed payment reply separately from the delivery result. NFT reconciliation reads the existing payment receipt before attempting delivery. Internal delivery-confirmed/completed transitions are recorded together; a polling client may see only COMPLETED.

## Asset handling

- Existing Devnet NFTs retain their mint and metadata. SPL transfers accept an agent-owned or explicitly delegated, unfrozen custody account. Core transfers accept agent ownership or an asset-level transfer delegate. Associated token accounts are created idempotently when needed.
- Tensor escrow is not owned by the agent. The existing fixed-recipient Vault payment does not buy/release Tensor escrow. Such orders report DELIVERY_FAILED and require the authorized seller/escrow release; they never mint a replacement or charge again. Programmable NFTs, compressed NFTs, collection-only delegates and transfer-hook assets need their respective marketplace/program integrations.
- The delivery adapter can mint a clearly labeled Core Devnet representation (`DEMO_NFT`), preserving selected name, description, source reference and HTTPS image. Existing Mainnet discovery remains read-only and does not invoke that adapter: this change does not bypass its purchase/verification gate or add a new checkout.
- RWA uses a Token-2022 mint per purchase with on-chain `DEMO RWA` metadata. Quantity is `reference budget / validated unit reference price`, floored to six decimals using integer arithmetic. SOL budgets use a validated SOL-to-USDC quote; USD wording retains the existing USDC reference convention. Original asset, price, reference amount/currency/time/source, actual Devnet payment amount, quantity, recipient and mint are stored. A mint per purchase makes atomic creation, issuance and mint-authority revocation prevent repeat issuance. These are test assets, not issuer-backed RWA ownership.

## Persistence and retry

Immutable account-scoped purchase plans and signed attempt slots prevent concurrent callers from broadcasting different attempts for one slot. Unknown sends reuse the same signed bytes. A replacement is allowed only after confirmed chain failure or absent historical status beyond finalized blockhash expiry. NFT transfers also create a deterministic account marker atomically, preventing duplicate delivery if historical transaction status is unavailable. Successful completion markers never cause reissuance when a user moves assets away.

Wallet & Assets reads both SPL token programs for linked wallets and refreshes Core ownership for tracked assets. Five-second shared reads reduce redundant RPC calls. Database records supply provenance, not ownership. RPC failures show unknown ownership/errors. Untracked Core/compressed NFTs are not discovered by the SPL scan.

## Runtime prerequisites and validation

Use the existing Devnet `NA_AGENT_KEYPAIR`, `SOLANA_RPC_URL` and mandate configuration. Agent SOL pays delivery fees/rent independently of the authorized payment. Set `NFT_DEMO_PUBLIC_URL` to a public backend URL for wallet metadata retrieval. Keep the original agent key while deliveries are pending. Metadata endpoints contain no private keys or recipient data. Token/NFT visual presentation depends on wallet support/indexing.

Historical paid RWA records lacking a saved price/quantity are held for reconciliation; the server does not invent a quantity or pay again. A backend restart and frontend rebuild are needed to load this implementation. Automated tests mock RPC/market/payment responses and validate actual signed transaction construction; they do not constitute a live Devnet delivery.

Protocol references: [Solana token metadata](https://solana.com/docs/tokens/extensions/metadata), [Metaplex Core transfers](https://www.metaplex.com/docs/smart-contracts/core/transfer).
