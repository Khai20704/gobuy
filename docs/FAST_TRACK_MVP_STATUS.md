# Genuine NFT purchase MVP — fast-track status

Application implementation and offline verification completed 2026-10-10 (Asia/Saigon).
**No real private keys accessed, blockchain transactions, SOL spending, upgrades or live enablement.**
Test keypairs sign only offline/mock transactions. Environment files, Anchor source, Program ID,
seeds, old Vault and historical orders are unchanged.

| Required field | Result |
| --- | --- |
| AUTHORIZATION_SUBMIT | **PASS** — offline round-trip, tampering rejection and uncertain submission handling |
| FRONTEND_PURCHASE_FLOW | **PASS** — Na integration, build/typecheck and mocked browser flow; real wallet/Devnet demo still gated |
| BACKEND_EXECUTION | **PASS** — offline concurrency/restart, network/budget gates and finalized delivery verification |
| COMPUTE_AND_PACKET_CHECKS | **PASS** — explicit 200,000 CU; archived account shape 943/1232 bytes; oversize refused |
| UNIT_TESTS | **PASS** — full suite 374/374; targeted suite 33/33 repeated after final verification changes |
| DEVNET_UPGRADE_READY | **NO** — operator CLI/signer/approval and live verification outstanding |
| EXACT_NEXT_ACTION | Prepare pinned Agave operator environment and identify the supported signer controlling the existing authority; obtain separate signing/upgrade approval |

## Implemented

- Authorization submit validates the real 120-byte payload, marketplace/executor/recipient, signature,
  discriminator, payer, account identities, budget and expiry. Route envelope fields no longer break the
  strict policy schema. Expired mandates are refused; policy expiry is capped by mandate expiry.
  Wallet-added compute settings have bounded fees. Submit retains the original signature rather than
  calling confirmation with absent lastValidBlockHeight; ambiguous transport remains pending.
- Na preserves discovery and Mainnet recommendations. Supported BUY listings show original mint, seller,
  price and estimated debit ceiling, with separate Phantom authorization and explicit genuine-purchase
  buttons. Missing mandates direct users to the existing Vault panel. Disabled/missing-listing/insufficient
  authorization/pending/failure states are explicit. New purchases never invoke the DEMO executor;
  historical DEMO reads/recovery remain available.
- Frontend persists original authorization signature and purchase discovery/owner before submission,
  polls only the existing attempt and blocks another purchase while uncertain. Wallet changes do not
  display another owner's result. A bare API CONFIRMED without receipt/delivery evidence is not success.
- Backend validates Tensor listing/account shape, Devnet and both budgets. A unique reservation token
  plus insert-once persistence allows only the winning worker to sign/send an order. Signature, blockhash
  and lastValidBlockHeight persist before broadcast; repeated requests and restarts reconcile only.
- Success requires a finalized program-owned receipt with matching canonical identity/budget fields and
  the original finalized transaction: GoBuy purchase discriminator/order/mint/price, new receipt creation,
  executor signer, Tensor CPI and original mint 0→1 in the owner's canonical ATA. Cached status, send/API
  responses or missing receipt alone cannot establish success. A later owner transfer does not invalidate
  verified historical delivery at execution time.

## Validation

| Check | Result |
| --- | --- |
| `npm test` | 374 passed, 0 failed across shared/backend/frontend/extension |
| NFT/auth/frontend targeted tests | 33 passed after final receipt/instruction checks |
| `npm run lint` | PASS, workspace and test TypeScript checks |
| Backend/frontend builds | PASS; Vite bundle-size and third-party annotation warnings remain |
| Tensor constants / installed SDK | 88 checks passed |
| Fixture regression tests | 9/9 passed |
| Mocked browser | 1 passed: authorization sign/submit/readback, single purchase, false-success rejection, pending/finalized rendering |
| Step 7 archive integrity | All 283 public JSON hashes unchanged |
| Target ELF | Rechecked hash/size/embedded ID; Anchor tree/workflow unchanged |
| Fresh read-only Devnet snapshot | Same old ELF, authority, old Vault and historical accounts |

Commands: [operator checklist](FAST_TRACK_OPERATOR_CHECKLIST.md).
Evidence: [readiness-check.json](evidence/fast-track/readiness-check.json),
[Devnet snapshot](evidence/fast-track/devnet-before.json),
[Step 7 verification](evidence/step8/verification-results.json).
Full logs are local `.fast-track-*.log`; a durable validation summary is retained in the evidence directory.
No new validator E2E or real Devnet purchase was performed. The 200k compute margin is based on the
archived classic-SPL fixture; heavier listings fail preflight rather than automatically increasing limits.

## Remaining blockers

1. Devnet still runs the old ELF. Program `CHjdqooB7TrussJoZoboFP5TtdCspoHtvPpqoshbr5zE`, ProgramData
   `GocAbEB3CrykEu5wTyZ4w888cQn2krEtuuEiMJGwqGek`, authority
   `6CndRMc647mRNyFLTXVefngq7kgouexvoVP6v4aZQ6JB`; authority signer control remains unproven.
2. Windows has no Solana CLI or installed WSL. Prepare pinned Agave and review signer/payer/refund
   parameters before approving buffer funding, extension or upgrade. Operator commands are provided
   for available PowerShell/Node checks; the future Linux deployment template still needs signer binding.
3. Target ELF SHA-256 `9c092a8d33903079f73d3ede303e71ea29ece86ff14f2f08a7f2d548943c902f`, 298456 bytes,
   and build provenance are preserved. The supplied PASS integration archive lacks its own run ID;
   identify the original integration run URL for operator review. GitHub authenticity is not invented.
4. Live layouts/PDA derivations are compatible observations; exact old deployed-source equivalence is
   unavailable. No migration identified. Recheck snapshots after upgrade. Latest rent estimate:
   **94,447,360 lamports** ProgramData top-up + **1,516,994,680** temporary buffer rent + fees/capacity margin.
5. Demo requires a genuine supported Devnet listing, separate test-owner mandate/executor funding,
   wallet signing approval and a one-order live window. Old expired mandate/Vault must not be used.
   No listing means no purchase, never a DEMO fallback.

Fail-closed limits: a crash after reservation but before broadcast may leave a RESERVED order requiring
manual diagnosis; absent history stays pending. Expired/depleted existing authorization needs owner-managed
revocation/recreation, not automatic budget increases. Multiple backend processes must share the durable
Mongo store or filesystem; independent local stores are unsupported. Browser tests mock Phantom/RPC and
do not establish real extension/cluster compatibility.

Application changes were already authorized. Signing, funding, upgrade and live enablement remain
separate operator actions; no additional implementation permission is needed.
