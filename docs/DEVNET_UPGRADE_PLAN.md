# Step 8 — Devnet upgrade plan

**PLAN_STATUS: NOT EXECUTED / BLOCKED.** This is a reviewable plan, not permission to run it.
Fast-track follow-up: application implementation and offline tests were subsequently authorized.
See [MVP status](FAST_TRACK_MVP_STATUS.md) and [current operator commands](FAST_TRACK_OPERATOR_CHECKLIST.md).
Signing with real wallets, spending, upgrading and live enablement remain separately gated.
[Readiness audit](DEVNET_READINESS_STEP8.md) and [retained evidence](evidence/step8/) define the baseline.
No key access, signing, transaction preparation/broadcast, upgrade, live enablement or purchase occurred.

## Fixed identity and approval boundaries

| Constant | Value |
| --- | --- |
| Program ID | `CHjdqooB7TrussJoZoboFP5TtdCspoHtvPpqoshbr5zE` |
| ProgramData | `GocAbEB3CrykEu5wTyZ4w888cQn2krEtuuEiMJGwqGek` |
| Authority | `6CndRMc647mRNyFLTXVefngq7kgouexvoVP6v4aZQ6JB` |
| Devnet genesis | `EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG` |
| Target ELF | 298456 bytes; `9c092a8d33903079f73d3ede303e71ea29ece86ff14f2f08a7f2d548943c902f` |
| Old payload | 279864 bytes; `2fe02be44d7ac3e2d0f05c04de29d5937bacad085039d5c924cb4b5785fc4a59` |

Phases 1, 2, 4 and read-only verification need no blockchain approval. Phase 3 signs an offline
challenge and needs explicit approval. Phase 5 is documentary preparation only. Phase 6 sends multiple
transactions and needs explicit upgrade/funding approval. Phases 7 and 8 separately require owner
and spending/live-enablement approval. Recovery writes require their own approval. The Step 8 prompt
also requires approval before implementing application changes; none is bundled into this plan.

Do not change Program ID/seeds, reset accounts, alter historical orders, use Mainnet, or spend the old Vault.
The old expired mandate and five SpendRecords are protected baseline accounts throughout this plan.

## 1. Pin verified source and artifact

Read-only/local. Preserve the downloaded archive and its SHA-256 listed in the audit. Retain the
passing raw evidence and identify the PASS integration run URL before the deployment review;
its run ID is absent from the report, so do not substitute build run 37964523776 for that run.
From the repository root, verify:

```powershell
git rev-parse HEAD
git rev-parse HEAD:anchor
git rev-parse 868d35fbc3818ceab5b0cd023773be62a7e36d3f:anchor
git diff --exit-code -- anchor .github/workflows/anchor-ci.yml
```

Audited harness HEAD is `f1a5a6156522e8dd2e48a60c57f9ca90a3da320b`; both Anchor trees must be
`66710f1c08529ff6414456be8c35e13a833f066e`. Documentation commits may advance HEAD; explicitly
review any source/harness changes rather than assuming HEAD must remain unchanged forever.
Obtain the original `.so` and checksum manifest from build run **37964523776**. Verify size/hash and
embedded Program ID with `scripts/verify-sbf-program-id.mjs <artifact.so> <ProgramID>`.

Gate: exact tested bytes, preserved provenance and fully reviewed source changes. Missing or mismatching
artifacts block deployment; a report label alone is insufficient.

## 2. Reproduce SBF build

Local build only, in an isolated Linux checkout. Use the existing `anchor-ci.yml` toolchain exactly:
host Rust **1.89.0**, Agave **3.0.14**, SBF platform-tools **v1.52**, committed Cargo.lock.
After installation, the repository's build commands are:

```sh
cargo metadata --manifest-path anchor/programs/gobuy_na/Cargo.toml --locked --format-version 1
cargo build-sbf --tools-version v1.52 --verbose --manifest-path anchor/programs/gobuy_na/Cargo.toml --sbf-out-dir anchor/target/deploy -- --locked
node scripts/verify-sbf-program-id.mjs anchor/target/deploy/gobuy_na.so CHjdqooB7TrussJoZoboFP5TtdCspoHtvPpqoshbr5zE
sha256sum anchor/target/deploy/gobuy_na.so
cargo test --manifest-path anchor/Cargo.toml --all-targets --locked
```

Compare checksum to phase 1. A different hash is a different deployment candidate, even if differences
appear to be metadata: investigate and rerun full local Step 7 against those exact bytes before approval.
Alternatively retain the original tested CI artifact as the sole candidate. No rebuild was run in this audit.

## 3. Verify authority control

**Requires signing approval.** Operator signs a fresh domain-separated message containing a nonce,
Program ID, Devnet genesis and expiry, then verifies the signature offline against the on-chain authority.
A wallet showing the address or a funded account is not proof of signing ability. Wallet accounts are not
cluster-specific; verify the RPC genesis independently. Do not expose/export any private key.

Gate: current ProgramData authority still matches, message signature verifies, and approved signer/payer
integration is identified. If unavailable, stop; do not create a replacement Program ID.

## 4. Preserve pre-upgrade snapshots

Read-only. Rerun `node docs/evidence/step8/read-devnet.mjs` only after archiving the existing snapshot
under a timestamped name, since that reader replaces `devnet-snapshot.json`.
Capture Program/ProgramData raw bytes, authority, deployment slot, hash, all program-owned accounts,
Vault, payer balance, rent quotes, genesis and per-request context slots. Quiesce execution so comparisons
are meaningful across different RPC slots. Preserve the old payload separately with its exact length/hash.

Gate: complete restorable binary archive plus account baseline; no pending purchases or concurrent writes.
Snapshots are comparison evidence, not authority to overwrite user accounts later.

## 5. Prepare upgrade procedure and funding review

Documentary preparation only in Step 8. Keep `NFT_PURCHASE_LIVE_ENABLED=false` and DEMO creation disabled.
Use the installed pinned CLI's `program deploy --help`, `program write-buffer --help` and upgrade/extend
help to specify the exact operator procedure and signer integration before any signing. Do not treat a
CLI deployment command as an unsigned dry run: it can create buffers, sign, pay and broadcast.

Record these reviewed parameters: explicit Devnet URL/genesis, existing Program ID, artifact path/hash,
upgrade authority, transaction payer, buffer authority/address, allocation size, fee cap and refund recipient.
Do not use default wallet/config assumptions or any command to change/finalize the upgrade authority.

The planned sequence is: create/fund buffer → upload exact bytes → verify buffer owner/authority/hash →
extend ProgramData if the reviewed CLI path requires it → upgrade existing program → verify/refund buffer.
Buffer writes/extension are separate chain mutations, even if final upgrade never occurs.

Snapshot estimates (re-query at execution):

| Item | Minimum requirement |
| --- | --- |
| ProgramData | 45 + 298456 = 298501 bytes, rent 1,517,035,320 lamports |
| Additional funding | 1,517,035,320 minus current 1,422,587,960 = **94,447,360** lamports |
| Buffer | 37 + 298456 = 298493 bytes, rent **1,516,994,680** lamports |
| Fees | Additional buffer-write, extension and upgrade fees; estimate from the actual procedure |

Observed authority balance was 10,345,547,689 lamports, but the chosen payer may differ. Account for
larger allocations if CLI defaults reserve spare capacity, fees, refund destination and a reserve.
The mechanics follow [Solana deployment documentation](https://solana.com/docs/programs/deploying)
and [loader deployment overview](https://solana.com/docs/core/programs/program-deployment);
verify actual installed CLI behavior rather than assuming `program upgrade` uploads/extends automatically.

Gate: exact procedure and cost review; signer verified; compatibility uncertainty explicitly reviewed;
client defect fixed/tested before planning the user-facing smoke test. No approval bypass for missing evidence.

## 6. Approved upgrade, then read-only verification

**Requires explicit approval for buffer funding/writes, extension and upgrade.** Only after that approval,
the operator executes the reviewed procedure. Record every transaction signature and funded account.
After finalization verify:

- Program ID, loader ownership and ProgramData link unchanged; deployment slot advances.
- Authority unchanged. Hash exactly the first **298456** bytes after the 45-byte ProgramData header;
  record any remaining capacity separately. Do not strip arbitrary trailing zeros from an ELF.
- Hash matches the tested target; new purchase instructions are present in the intended build.
- All baseline Mandate/SpendRecord raw data and lamports, and old Vault balance, remain unchanged.
- Payer debit and buffer recovery match reviewed rent/fees; no unexpected authority/funding destination.

Gate: every comparison passes. If any fails, keep execution disabled and investigate before signing again.
Do not create user accounts as part of upgrade verification.

## 7. New test-only owner mandate and authorization

**Requires separate owner approval and funding.** Use a distinct test wallet, leaving the expired old mandate,
its Vault and all historical receipts untouched. Determine the small budget from a verified supported listing,
fees and rent before proposing an amount. No listing means stop; no replacement/demo NFT fallback.

Owner creates a fresh short-lived NFT/ANY mandate with the intended executor, then requests the unsigned
transaction from `POST /api/nft-purchases/authorization`, reviews budget/marketplace/executor/recipient/expiry,
signs in the wallet and submits through `POST /api/nft-purchases/authorization/submit`.
The fast-track implementation fixes the offset-184 defect and adds signed round-trip/tampering tests.
Authorization is read back at finalized commitment; no live wallet test has been run.

Read back the 203-byte authorization: correct discriminator/version, mandate, owner, executor, Tensor,
recipient=owner, active, zero spent, budget within remaining mandate budget and a suitable expiry.
Anchor does not cap authorization expiry to mandate expiry; the updated application now caps it explicitly.
Gate: finalized matching authorization and mandate. Unknown submission outcome means reconcile, not re-sign.

## 8. One small-budget genuine Devnet purchase

**Requires explicit spending and live-enablement approval.** Mainnet remains recommendation-only.
Recheck the genuine Tensor Devnet listing from RPC: supported classic SPL NFT, mint/metadata, canonical
listing/escrow, seller, public SOL price, no unsupported cosigner/private-taker/broker conditions,
canonical owner ATA, and authorized executor. Verify dependency program versions against the tested fixture.

Review price + 5% + 5,000,000 ceiling against both budgets and Vault balance, with executor fee/receipt rent
separate. Serialize the exact transaction to check packet size; after separate approval for transaction
preparation/simulation, verify actual compute usage. Backend now requests 200,000 CU based on the archived
111,992-CU purchase and approximately 114,954-CU largest negative. Original Step 7 requested roughly
1,000,000 CU; the updated transaction packet is 943 bytes for the archived account shape.

Restrict the execution window to the one test operator/order and quiesce other workers. A global live flag
alone is not a one-purchase control. Only then enable execution temporarily and submit **once**. Disable it
and reload/verify configuration immediately afterward regardless of response; editing an env file alone
may not disable an already running process.

Persist the order identity, expected receipt, signed transaction signature and validity context for recovery.
If the current implementation cannot provide reviewed restart/concurrency safety, that is a release blocker.
Any PENDING/UNKNOWN or transport ambiguity goes to status reconciliation; never start another discovery to retry.

## 9. Verify transaction, delivery and accounting

Read-only. Require finalized transaction with `meta.err === null`, original expected signature/message,
agent as fee payer/signer, GoBuy depth 1 and one intended Tensor BuyLegacy at depth 2. Legitimate nested
System/Token/ATA/metadata/event invocations are allowed; inspect their destinations and amounts.

Verify original mint supply/data, transfer into the authorized owner's canonical ATA at execution,
listing/escrow closure, seller payment and marketplace fees. Compare immediate before/after snapshots:
Vault decrease = receipt total debit = each budget counter increase, within both approved ceilings.
Verify receipt discriminator/size and every identity field, price/order ID; executor paid fee and receipt rent.
Separate account snapshots can be affected by later transactions, so reconcile against transaction metadata.
Historical accounts and old Vault must still match phase 4. A later owner NFT transfer is not evidence of
failed delivery at execution time.

Gate: all evidence consistent; API success alone is insufficient. Failed transactions may exist on chain
with a fee, while purchase account changes and new receipt creation roll back atomically.

## 10. Recovery and rollback

- **Upload/extension failure:** final executable may remain old while buffers, funding and allocation changed.
  Re-read every affected account and signature. Only the final upgrade instruction is atomic, not the whole
  multi-transaction deployment. Close a specifically identified unused buffer only with recovery approval.
- **Unknown upgrade result:** inspect finalized ProgramData hash/slot and original signatures before retrying.
- **Binary regression:** disable purchasing. A rollback is another explicitly approved upgrade using preserved
  old ELF/authority. Allocation may remain larger: compare the old 279864-byte payload prefix and padding.
  A binary rollback does not undo purchases, refund spent funds or revert account writes.
- **New accounts after upgrade:** old binary cannot manage new authorizations/receipts. Plan owner revocation
  while compatible code is available; retain receipts and history. Do not reset accounts to make rollback fit.
- **Uncertain purchase:** absent receipt, null signature status or RPC timeout is not proof of failure. Poll
  the original signature and canonical receipt with appropriate commitment/history, checking validity bounds;
  retain UNKNOWN/PENDING if still unresolved. Never retry using another order/discovery ID.
- **Definitive failure:** confirmed/finalized failed transaction rolls back purchase effects but charges fees.
  A verified preflight rejection does not broadcast. A new attempt needs a separately reviewed outcome and approval.
- **Owner recovery:** authorization close/revocation and mandate cancellation/withdrawal require owner signatures.
  Cancelling refunds available budget; withdrawal on inactive/expired mandate closes it. These are not audit actions.

Safest next action: prepare the operator CLI and identify the supported authority signer, then obtain
separate signing/upgrade approval. Application changes were authorized and implemented in the fast-track task.
This plan does not authorize any deployment or claim any successful Devnet purchase.
