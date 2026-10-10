# Step 8 — Devnet deployment readiness and safety audit

Audit completed 2026-10-10 (Asia/Saigon). Blockchain access was public, read-only RPC.
This is the historical pre-fix audit. Subsequent application implementation was authorized;
see [FAST_TRACK_MVP_STATUS.md](FAST_TRACK_MVP_STATUS.md) for current fixes/tests and deployment blockers.
No key was accessed, transaction signed/sent, upgrade performed, live flag changed, or historical order modified.
Application implementation changes below are proposals only, as required by the supplied Step 8 prompt.

| Required field | Result |
| --- | --- |
| STEP8_STATUS | **BLOCKED** |
| STEP7_EVIDENCE_VERIFIED | **YES, within the supplied local-validator artifact**: raw positive + 9 negative cases rechecked offline; not a new E2E run or Devnet purchase |
| DEPLOYED_PROGRAM_VERIFIED | **YES**, fresh finalized RPC snapshot |
| DEPLOYED_BINARY_MATCH | **NO** |
| UPGRADE_AUTHORITY | `6CndRMc647mRNyFLTXVefngq7kgouexvoVP6v4aZQ6JB`; possession unverified |
| ACCOUNT_COMPATIBILITY | Observed layouts/PDA derivations compatible; no migration identified; deployed-source equivalence unproven |
| PURCHASE_AUTHORIZATION_SAFETY | On-chain guards verified in source and archived tests, subject to scope below; client submit is broken |
| BACKEND_FRONTEND_GAPS | Submit defect, missing frontend, compute parity and recovery/concurrency coverage |
| REQUIRED_CHANGES | See Task 5; implementation requires approval |
| DEPLOYMENT_RISKS | Untested live upgrade, signer control, authority funding, existing expired mandate, marketplace/runtime drift, recovery semantics |
| NEXT_SAFE_ACTION | Approve the narrowly scoped authorization-submit fix and offline round-trip/tampering tests; keep live purchasing disabled |

## Task 1 — Step 7 evidence verified

The previous draft's claim that raw evidence was missing was incorrect. The complete archive is
`C:/Users/khait/Downloads/tensor-integration-prerequisites (3).zip`, SHA-256
`89151176925da297cedb2a79baa8c5e9c85592d9e95a19e6bd364d33c198f9a4`.
Public JSON evidence is retained under [step7-pass](evidence/step8/step7-pass/), with original
paths flattened using `__`. It includes all transaction/state JSONs, build provenance and program readiness.
This audit inspected the supplied archive; it did not independently authenticate the PASS run through GitHub.
The passing integration run ID is not recorded in its report; the build run ID is recorded.

| Provenance | Verified value |
| --- | --- |
| Harness HEAD | `f1a5a6156522e8dd2e48a60c57f9ca90a3da320b` |
| Build run / source | `37964523776` / `868d35fbc3818ceab5b0cd023773be62a7e36d3f` |
| HEAD:anchor and build-source:anchor | Both `66710f1c08529ff6414456be8c35e13a833f066e`, re-derived with Git |
| Tested ELF | 298456 bytes; `9c092a8d33903079f73d3ede303e71ea29ece86ff14f2f08a7f2d548943c902f` |
| Local downloaded build | `Downloads/anchor-program-sbf/anchor/target/deploy/gobuy_na.so`: same size/hash; embedded Program ID checked |
| Runtime | Fresh local validator 3.0.14, Node 22.23.3, 2026-10-09 19:00:22–19:01:21 UTC |

Reproducible offline verification: `node docs/evidence/step8/verify-evidence.mjs`.
[Verification results](evidence/step8/verification-results.json) record the actual errors/CU for all ten cases.
The verifier checks raw account bytes, not only the report's PASS labels.
Existing NFT unit tests also passed **13/13**. No new validator E2E or SBF rebuild was run.

Positive purchase signature:
`5rZuLByBCWjVojS7twz74Fjrg7rQikR7z1EFBrCUHWPmKKbbPrWUGp3wtsGnwqca1gS2rq41Yhmw4DcsYAVjj1Ca`.
GoBuy invokes at depth 1, Tensor BuyLegacy at depth 2, with the Vault as CPI payer and the
executor as sole outer signer. Other legitimate nested calls include System, Token, ATA and Tensor events.

- Original mint `HVT5HUf9mmqvtwMjpQzJzUB6Nb6exumabw4sKkc5shny` is unchanged and delivered as
  amount 1 to the owner's canonical ATA. Listing and escrow token accounts close.
- Vault debit **104,039,280** = price **100,000,000** + Tensor fees **2,000,000** + ATA rent **2,039,280** lamports.
- Both mandate and authorization counters increase by exactly **104,039,280**.
- Receipt raw bytes bind mandate, authorization, owner, executor, mint, listing, marketplace,
  order ID and debit. Executor pays **5,000** transaction fee + **2,797,920** receipt rent; owner SOL unchanged.
- Positive transaction consumed **111,992 CU**. Harness explicitly requests approximately **1,000,000 CU**;
  it does not prove execution with the backend's default compute budget.

| Negative case | Observed error | State verification |
| --- | --- | --- |
| Duplicate order | Custom 0, instruction 1 | Existing receipt and purchase state unchanged |
| Invalid listing | InvalidListing / 6017 | Unchanged except actual fee payer's transaction fee |
| Wrong mint | InvalidListing / 6017 | Same |
| Unauthorized executor | InvalidOwner / 6004 | Same |
| Expired authorization | PurchaseAuthorizationExpired / 6013 | Same |
| Insufficient mandate budget | BudgetExceeded / 6002 | Same; before Tensor |
| Insufficient authorization budget | PurchaseAuthorizationBudgetExceeded / 6015 | Same; Tensor reached then rolled back |
| Invalid destination | InvalidBuyerTokenAccount / 6020 | Same; before Tensor |
| Transaction rollback | Custom 1, instruction 2 | GoBuy/Tensor succeed, later instruction fails; all purchase state restored |

Historical Step 7 documents/status describe earlier blocked attempts. They must not override this
later raw evidence, and the archive's own stale status.json must not be mistaken for its runtime report.json.
No local-validator signature is presented as a Devnet transaction.

## Task 2 — Fresh read-only Devnet audit

[Raw snapshot](evidence/step8/devnet-snapshot.json), captured **2026-10-09T23:35:03.817Z**, retains
full ProgramData bytes and program-owned accounts. RPC calls use finalized commitment; separate
requests have separate context slots and are not a single atomic snapshot.
The reproducible reader is [read-devnet.mjs](evidence/step8/read-devnet.mjs).

| Field | Observation |
| --- | --- |
| RPC / genesis | `https://api.devnet.solana.com` / `EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG` |
| Program | `CHjdqooB7TrussJoZoboFP5TtdCspoHtvPpqoshbr5zE`, executable, upgradeable loader |
| ProgramData | `GocAbEB3CrykEu5wTyZ4w888cQn2krEtuuEiMJGwqGek`, deployment slot 507462454 |
| Upgrade authority | `6CndRMc647mRNyFLTXVefngq7kgouexvoVP6v4aZQ6JB` |
| Authority balance | 10,345,547,689 lamports at snapshot; not proof of key possession |
| ProgramData allocation/balance | 279909 bytes / 1,422,587,960 lamports |
| Payload after 45-byte header | 279864 bytes; SHA-256 `2fe02be44d7ac3e2d0f05c04de29d5937bacad085039d5c924cb4b5785fc4a59` |
| Existing accounts | One 181-byte Mandate, five 194-byte SpendRecords |
| Existing Vault | `GfjKEqEPghVscwJ3piwGwQvbxtug7quUVZBpi1kQJZEC`, 960,650,240 lamports |

The deployed payload differs from the tested ELF. Earlier inspection and the retained payload's
legacy instruction strings, with new purchase strings absent, support a settlement-only deployment.
String inspection is supporting evidence, not a runtime dispatch proof. No new instruction was invoked.
The instruction-name extraction in the snapshot is a rough regex over concatenated binary strings,
not a complete ABI listing. Raw discriminator absence alone is not proof of an absent instruction.

The mandate `7gfmi99mSw52BDyCroKvYAXmVguLVKSGHqLBhFQacABB` derives from owner
`9dJL3iVoECg6yaAeCoF3wKBPbkJkQE1WEucKm2fZUcAE`; mandate and Vault bumps both recheck as 255.
It has 1,000,000,000 budget / 40,000,000 spent and expired at **2026-10-09T16:04:48Z**.
Leave it, its Vault and all historical receipts untouched; use a separate test wallet later.

## Task 3 — Upgrade compatibility

Current source retains four legacy instruction names and adds three purchase instructions.
Legacy names preserve discriminators; matching names alone do not prove the complete old ABI.
Live accounts have the expected discriminators and sizes and decode plausibly at current offsets.
This supports compatibility, but deployed-source provenance is unavailable: unconditional safe-replacement
claims are not justified. Preserve snapshots and validate legacy account metas/arguments before approval.

| Account | Discriminator | Bytes | Current Devnet rent minimum |
| --- | --- | --- | --- |
| Mandate | `71d8629fb93f3712` | 181 | 1,569,720 |
| SpendRecord | `0ca553109f951940` | 194 | 1,635,760 |
| NftPurchaseAuthorization | `0b4784d9340f7064` | 203 | 1,681,480 |
| NftPurchaseReceipt | `70f17c093f2619be` | 274 | 2,042,160 |

Seeds remain `[mandate, owner]`, `[vault, mandate]`, `[spend, mandate, spend_id]`.
New seeds are `[nft-auth, mandate]` and `[purchase, mandate, order_id]`; both new accounts use `init`.
Owner creates/closes authorization; receipts remain for replay protection. No migration identified;
no reset/reallocation of existing user accounts is proposed. Legacy settlement and historical DEMO
reads remain separate; no DEMO fallback is allowed for new genuine orders.

Authorization creation checks active/not-closed and its **own** expiry, but does not reject an expired
mandate at creation. Purchase separately rejects mandate expiry. The previous draft confused these checks.
If a mandate is ever recreated at the same PDA, review/close any surviving authorization first with owner
approval; do not assume it is automatically tied to a new mandate incarnation.

Target ProgramData minimum = 298501 bytes (45 + ELF), growth 18592 bytes. Current RPC rent minimum
is **1,517,035,320**; top-up against observed balance is **94,447,360** lamports.
A loader-v3 Buffer uses a **37-byte** header: minimum 298493 bytes costs **1,516,994,680** lamports.
These replace the earlier draft's incorrect 0.259/4.16 SOL estimates. Re-query actual chosen allocations,
fees and balances before signing; buffer funds are temporary and their recovery destination must be reviewed.
Do not assume every CLI upgrade path performs allocation/extension automatically.

Outer purchase has 6 fixed + 24 Tensor account entries, with repeated keys deduplicated in the message,
and 64 bytes of instruction data. Recheck the exact serialized packet against the 1232-byte limit and
measure CU on the planned transaction; archival CU does not guarantee a different listing/runtime.

## Task 4 — Purchase authorization policy

Sources: `anchor/programs/gobuy_na/src/{lib,nft_purchase,nft_purchase_rules}.rs` and
`backend/src/services/nft-purchase/`, plus shared policy rules.

- A separate owner-signed authorization is required. Old settlement mandates alone grant no marketplace purchase permission.
- Executor, owner/recipient, mandate and authorization are bound; Vault is the signed CPI payer.
  The purchase path grants no unrestricted System withdrawal instruction to the executor.
- GoBuy pins Tensor and Token/ATA programs, validates mint/listing PDA/canonical buyer ATA and checks token delivery.
  Seller/listing semantics also rely on genuine Tensor validation; the backend compares seller to discovery.
- This is broad marketplace spending authority, **not owner approval of one particular mint/seller/price**.
  The executor chooses the listing and max price within both budgets. Self-dealing/overpriced genuine listings
  are not ruled out by these guards; do not describe the authorization as preventing every economic misuse.
- Measured Vault debit includes fees/ATA rent and is bounded by price + 5% + 5,000,000 lamports, mandate budget
  and authorization budget. Receipt rent and transaction fees are paid separately by the executor.
- Mandate and authorization expiry, nonzero order ID and receipt `init` enforce expiry/replay checks.
  Atomic failure rolls back account changes, including receipt creation; failed transactions can still appear on chain and charge fees.
- Delivery is checked at execution time. A later owner transfer can move the NFT; current ATA absence alone
  does not disprove an earlier successful purchase.

**Confirmed client defect:** `NftPurchaseAuthorizationClient.submit` requires 120-byte instruction data
then calls `readUInt8(184)`. A valid matching limit reaches this out-of-bounds read before broadcast.
Replace that invalid term with validation of actual fields: marketplace 24..56, executor 56..88,
recipient 88..120, preserving discriminator/accounts/signature/limit/expiry checks. Implementation awaits approval.

## Task 5 — Backend/frontend gaps and required changes

The backend has discovery verification, Devnet restriction, separate authorization, CPI construction,
receipt reconciliation and a default-off live flag. Mainnet stays recommendation-only; RPC suffices for
marketplace validation. Private signing material belongs only in backend/wallet boundaries.
The frontend currently has no genuine-purchase API client or complete authorize/purchase/receipt UI.

| Priority | Proposed minimal change | Validation required |
| --- | --- | --- |
| 1 | Fix authorization-submit validator | Offline signed round-trip plus tampered field/account/signature rejection; no broadcast on invalid input |
| 2 | Add frontend client and /na flow | Authorize → wallet sign → submit → purchase once → poll → receipt; distinct disabled/pending/failure states; no DEMO fallback |
| 3 | Verify backend compute/packet parity | Exact planned transaction serialization and simulation after separate approval; retain default-off flag |
| 4 | Review durable attempt/reconciliation edge cases | Concurrent requests, restart around broadcast, receipt temporarily absent, RPC ambiguity and confirmed/finalized transitions |
| 5 | Reconcile historical Step 7 documentation | Link this preserved PASS artifact without erasing earlier failures; record integration run URL if available |

The service reserves before signing and derives receipt identity from discovery ID, but read-then-write
and order-ID equality alone are not a demonstrated exclusive execution lock. On-chain replay protection
prevents two successful purchases for the same receipt; it does not prevent duplicate fee-bearing submissions.
A missing receipt is **not proof of failure**. Preserve UNKNOWN/PENDING and reconcile the original signature;
do not create a new discovery ID to bypass uncertainty. A confirmed receipt is not yet finalized evidence.
Existing tests omit submit round-trip and do not establish all concurrency/restart behavior.

## Task 6 — Deployment plan and remaining risks

See [DEVNET_UPGRADE_PLAN.md](DEVNET_UPGRADE_PLAN.md) for ten ordered phases and explicit approval boundaries.
No phase involving signing, buffer writes, extension, upgrade, mandate creation, live enablement or spending
was executed. The upgrade requires a proven signer, exact tested ELF, fresh snapshots/funding, and reviewed
legacy compatibility. The smoke test additionally requires client fixes, a fresh test-only mandate and a genuine
supported Devnet listing; absence of a listing is a blocker, never permission to use DEMO.

Binary rollback cannot undo a purchase or restore account state, and the old binary cannot manage new
purchase authorizations. Retain historical receipts; plan revocation/recovery before rolling back.

**Single next safe action:** approve change #1 (submit validation + offline regression tests).
Step 7 artifact verification is now complete within its stated provenance boundary. Devnet purchase and
upgrade readiness remain **BLOCKED**; no Devnet purchase success is claimed.
