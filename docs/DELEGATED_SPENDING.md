# Na Vault + on-chain spending mandate (Devnet)

Phantom signs create/fund, revoke and reclaim transactions. A signed message is used only to associate a wallet with an app account; it never grants spending authority.

## Implemented flow

- Mandate PDA: ["mandate", owner]. Vault PDA: ["vault", mandate]. Immutable receipt: ["spend", mandate, spend_id].
- Create funds the vault with the authorized SOL budget plus the zero-data account rent floor. The owner additionally pays mandate rent and network fees.
- The owner chooses a fixed settlement recipient and authorizes the server's dedicated Devnet executor public key in that transaction.
- Only that executor may trigger a spend. The program checks active status, expiry, category, budget, vault PDA and recipient. It signs a vault transfer and updates spent only after the transfer succeeds atomically.
- Revoke stops spending and refunds the unused balance above the vault rent floor. Reclaim after revocation or expiry returns the entire vault balance and closes the mandate, refunding mandate rent too.
- A new mandate requires a new owner signature after closing the previous one. Immutable receipts survive closure.
- The API retains unsigned messages and their blockhash expiry for two minutes. Restarting the backend requires rebuilding any unsubmitted owner transaction. Deploy this MVP as one backend instance.
- Unknown submission/confirmation results return PENDING with the locally known transaction signature. Check Explorer/history before another action.

## Execution limitation

The vault demo performs a real Devnet SOL settlement transfer. It does not deliver an NFT/RWA and must not be called a successful asset purchase. Category and asset hash are executor-provided metadata; there is no marketplace verification or asset-delivery CPI. The fixed recipient is an explicit trust choice.

Existing NFT discovery is preserved. Marketplace purchases remain separate owner-signed transactions using wallet funds, and do not consume or claim protection from the vault budget. Mainnet discovery/RWA quotes are read-only. No Mainnet execution is enabled.

The demo API requires authentication and a verified association with the owner wallet before using the server executor. Repeating the same mandate/asset/amount/reference produces the same spend ID; changing those fields is a distinct payment. Receipt IDs remain reserved across replacement mandates at the same PDA.

## Setup

1. Build and deploy the updated Anchor program on Devnet. The committed System Program sentinel is not a deployment.
2. Set NA_PROGRAM_ID to that deployment. This layout adds an executor public key and is incompatible with earlier mandate layouts. Do not point it at an old program.
3. Set NA_AGENT_KEYPAIR on the backend to a dedicated Devnet-only keypair (64-byte JSON array or base58). Never use/export the Phantom owner's key. Fund this agent with Devnet SOL for fees and receipt-account rent.
4. Optionally set NA_SETTLEMENT_ADDRESS to pin the only allowed recipient. Set SOLANA_NETWORK=devnet and SOLANA_RPC_URL to a Devnet endpoint. Genesis is verified before transaction construction/broadcast.
5. Start the app, connect Phantom, select Devnet, create a budget, and inspect the transaction before signing.
6. Expand the settlement demo to execute multiple transfers, inspect their receipts/Devnet Explorer links, then revoke and reclaim.

API prefix: /api/mandate. GET /config, GET /?owner=..., GET /spends?owner=..., POST /transaction, POST /submit, POST /spend.

## Validation

Run npm run build, npm run lint, and npm test. Focused mandate tests are in backend/tests/mandate.test.ts. Rust rule tests cover the requested seven budget/lifecycle scenarios; run cargo test --manifest-path anchor/Cargo.toml with a working Rust linker. Rule tests alone do not prove deployed runtime behavior: test create, multiple spends, rejection, revoke and reclaim against the deployed Devnet program before claiming a live demonstration.
