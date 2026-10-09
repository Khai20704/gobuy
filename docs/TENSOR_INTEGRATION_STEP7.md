# Step 7: real GoBuy to Tensor CPI tests

## Latest fix: closed seller ATA after genuine listing

The supplied report for harness commit `74251a3e70778a3fa85d4438a4a419b413db2cca`
(run `37975495485`) records `valid-purchase: FAIL`, with all nine negatives blocked.
The actual `valid-purchase-before-state.json` was read from the user's extracted artifact:
seller ATA and buyer ATA are absent, decoded seller/buyer are null, escrow exists with
amount `1`, original mint `3FYJorzJRuzb6eA935pktX1fpVKw4PKZh48WcyC5tSpd` and listing authority
`E15HPRqJZGPftXuNMWchXgPmTKpTBEXfAFxtsXFjNQCE`; receipt is null.

Exact failing expression: `before.decoded.seller.amount` (former line 327).
ListLegacy closes the seller token account after escrowing the NFT. The harness wrongly
expected a decoded seller account with amount zero. This exception precedes the call that
submits the GoBuy purchase; the expected account-less dispatch error 3005 is unrelated.

Fix: `scripts/tensor-fixture-assertions.mjs` explicitly validates canonical addresses,
SPL ownership, original mint, token authority, initialized/unfrozen state and balances.
Escrow must exist with amount one. Seller/buyer may be absent with null decoded state;
if present they must be correctly owned empty token accounts. No optional chaining or
missing-account-to-zero fallback masks invalid escrow. The E2E harness uses this helper,
requires an existing decoded buyer ATA after purchase, and charges expected ATA rent only
when the buyer ATA was absent before purchase. CPI, payment, budgets, receipt and rollback
assertions are retained; dispatch checks are untouched.

Changed for this fix: `scripts/tensor-local-e2e.mjs`, new
`scripts/tensor-fixture-assertions.mjs`, new `scripts/tensor-fixture-assertions.test.mjs`,
`.github/workflows/tensor-integration.yml` (run regressions before E2E), and this report.
Pre-existing workflow diagnostic edits and untracked slot-zero evidence were preserved.

Local results: 9/9 regression tests, 13/13 existing purchase unit tests, offline SDK/packet
checks, script syntax, workflow YAML and diff checks passed. These do not count as E2E.
Full local E2E was attempted through preflight. Its first blocker was public RPC error
`-32016: Minimum context slot has not been reached` while snapshotting Authorization Rules;
the suite and all negative cases were not reached. The attempt report remains at
`.tmp-step7-null-fix/report.json`. Linux CI is also necessary because this machine has no
validator. No new GitHub Actions run was dispatched (no authenticated
dispatch capability); there is **no new run ID**. Publish the fix and start a new run with
`step7=true`. Original NFT delivery, Vault payment, receipt and all nine negative outcomes
remain unverified. No on-chain program or historical state was modified.

## Latest dispatch-gate investigation

### Resolved with supplied simulation evidence

The user supplied the actual response, now preserved as
[failed-slot-zero-dispatch.json](evidence/step7/failed-slot-zero-dispatch.json):

```text
context.slot: 0
InstructionError: [0, "UnsupportedProgramId"]
Program TCMPhJdwDryooaGtiocG1u3xcYbRpiJzb283XfCZsDp invoke [1]
Program is not deployed
Program TCMPhJdwDryooaGtiocG1u3xcYbRpiJzb283XfCZsDp failed: Unsupported program id
unitsConsumed: 0
returnData: null
```

**Cause: the probe ran against the genesis bank before program visibility.** Runtime
invocation was attempted, but BuyLegacy never dispatched; the invocation line alone is not
execution proof. The bank was slot 0. Agave v3.0.14's genesis loader assigns local
ProgramData deployment slot 0, while its
[program cache](https://github.com/anza-xyz/agave/blob/v3.0.14/program-runtime/src/loaded_programs.rs)
defines a one-slot visibility delay. The harness treated RPC health plus executable/hash
checks as execution readiness. Those checks can pass before the bank advances. This is
not evidence of a wrong Tensor ID or a missing ELF; it is also not BlockhashNotFound.

Fix: read each **local** ProgramData deployment slot during existing bytecode verification,
wait up to 60 seconds for the confirmed bank to reach the maximum deployment slot plus one,
and pass that minimum context slot to blockhash acquisition and simulation. Remote deployment
slots are deliberately not used. Record observations in `program-readiness.json` and fail
closed on timeout/validator exit. The strict dispatch evidence checks remain unchanged.
No program bytes, features, IDs, seeds or purchasing behavior are modified.

The new change affects `scripts/tensor-local-preflight.mjs`, this report and the preserved
failure JSON, in addition to the earlier uncommitted diagnostic/workflow edits below.
Syntax, workflow YAML, seven synthetic evidence-gate checks and diff checks passed.
**Linux verification still required:** no successful dispatch or purchase is claimed.

The following records the earlier investigation before the response became available:

Run **37974427649**, commit `a674f2a34d241b60911504e2122b5c8f76080cba`, failed
(public GitHub API verified). The user confirms validator startup and all bytecode checks
passed, but the probe raised `Expected genuine BuyLegacy dispatch/account-validation evidence missing`.
Full GoBuy CPI purchase did not execute. The implementation report below predates this run.

**Exact runtime root cause: not yet established.** Artifact `11636589925` exists, but its
unauthenticated download returned HTTP 401. No local copy of the latest simulation response
was found. The generic error alone cannot distinguish a blockhash/account-loading failure,
a Tensor execution error, or unexpected logs. The missing `value.err` and `value.logs`
were requested from the user; no runtime logs are fabricated here.

The control flow does establish that the local `simulateTransaction` request returned and
`buy-legacy-dispatch-simulation.json` was saved before that exact error was thrown. Thus this
was not merely instruction construction or a never-attempted RPC call. It does **not** establish
that Tensor was invoked: a simulation response can contain a transaction-level failure and
no program logs. The flag remained false because the response failed the old checks for a
non-null error, BuyLegacy log and AccountNotEnoughKeys log. The E2E module is called only
after those checks and the flag assignment, so the purchase suite was not reached.

Changes prepared for the next run:

- `scripts/tensor-local-preflight.mjs`: records the exact simulation request, public payer,
  payload, blockhash/context/options, RPC failures and full response, with a readable log.
  Evidence includes instruction error, return data, compute units, replacement blockhash
  and inner instructions. The probe is unsigned and never broadcast; its signature field
  is explicitly null, not the zero-filled placeholder interpreted as a real signature.
- The evidence gate now requires the exact Tensor `invoke [1]` line, BuyLegacy and named
  missing-account logs inside that invocation's failure boundary, and instruction 0's
  `Custom: 3005` error. Unexpected success, other programs, missing logs and other errors
  fail closed. `tensorDispatchExecuted` is assigned only after every check passes.
- Blockhash acquisition now uses the same `confirmed` commitment as simulation, and unsigned
  simulation requests `replaceRecentBlockhash: true`, as supported by the
  [Solana RPC specification](https://solana.com/docs/rpc/http/simulatetransaction).
  This removes a blockhash timing dependency; **BlockhashNotFound is a hypothesis, not the
  confirmed cause of this run**. No retry or broad error acceptance hides other failures.
- `.github/workflows/tensor-integration.yml`: prints dispatch evidence and logs on failure;
  the existing always-upload patterns already preserve these files.
- `docs/TENSOR_INTEGRATION_STEP7.md`: records this investigation and verification limits.

Local checks: seven synthetic evidence-gate unit cases passed (expected validation, missing
blockhash, missing invocation, wrong error, unexpected success, wrong program and null logs).
These are parser/control-flow tests, **not genuine Tensor execution**. Both script syntax
checks, workflow YAML/opt-in/always-upload checks and `git diff --check` passed.
The E2E harness, Rust source, program IDs, seeds, wallet logic and Anchor CI were not changed
by this investigation. No deployment or purchase occurred.

**Remaining blocker / next action:** provide the failed run's
`buy-legacy-dispatch-simulation.json`, or publish these diagnostics and start a new Linux
workflow run. Inspect `buy-legacy-dispatch-evidence.json` and the raw response to identify
the actual first error. The fix remains unverified in CI; no Tensor dispatch, NFT delivery,
Vault payment, receipt or negative-test success is claimed for this failed run.

**STEP7_STATUS: BLOCKED — implemented, not executed on a validator.**
No purchase, delivery, Vault payment or authorization/receipt outcome is verified by this work.

## TEST_ENVIRONMENT

The public GitHub API confirmed [Step 6 run 37969595238](https://github.com/Khai20704/gobuy/actions/runs/37969595238)
succeeded at commit `a719a284a76dafc38f3c7f3683caf561aa4ea99d`. The user supplied the three
passing preflight flags. Full Step 6 artifact contents were not downloaded in this session.

The Step 7 harness is a workspace change based on that commit; its final commit/run ID does
not yet exist. Linux CI retains Agave **v3.0.14**, Node **22**, the existing port range
`19000-19050`, fresh ledgers, incremental startup, full logs, executable/bytecode checks and
the genuine dispatch probe. Step 7 runs only when its new manual input is enabled.

Selected GoBuy build: [37964523776](https://github.com/Khai20704/gobuy/actions/runs/37964523776),
source `868d35fbc3818ceab5b0cd023773be62a7e36d3f`; ELF 298456 bytes, SHA-256
`9c092a8d33903079f73d3ede303e71ea29ece86ff14f2f08a7f2d548943c902f`.
The current and build-source `anchor` Git trees both equal
`66710f1c08529ff6414456be8c35e13a833f066e`. No Rust source was changed.
CI checks that complete tree and the original build workflow match the selected artifact's
source commit, then verifies the original artifact checksum manifest and embedded Program ID.
A mismatch requires a new Anchor CI build, not testing a stale binary.

| Program | Intended ID |
| --- | --- |
| GoBuy | `CHjdqooB7TrussJoZoboFP5TtdCspoHtvPpqoshbr5zE` |
| Tensor | `TCMPhJdwDryooaGtiocG1u3xcYbRpiJzb283XfCZsDp` |
| Token Metadata | `metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s` |
| Authorization Rules | `auth9SigNpDKz4sJJ1DfCTuZrZNSAgh9sFD3rboVmgg` |
| SPL Token | `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA` |
| ATA | `ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL` |

SDKs already in the lockfile: Tensor marketplace **1.0.0**, Tensor's Metaplex client
**1.0.0-beta.1**. No dependency updates. `npm ci --ignore-scripts` plus explicit shared/adapter
builds prepares CI. Actual validator and Node versions, artifact/source provenance and all
loaded program hashes are included in the runtime report.

Local attempt: Windows, Node **v24.20.0**. All five public ELF snapshots succeeded; execution
stopped before starting a validator because `solana-test-validator` is absent. See
[local-preflight.json](evidence/step7/local-preflight.json). This is availability evidence only.

## FIXTURE_SETUP

Implemented in `scripts/tensor-local-e2e.mjs`; **no on-chain fixture addresses exist yet**.
Each independent case generates fresh in-memory seller, owner, executor, intruder and mint
keypairs, funded by local airdrops. No wallet or `.env` file is read and no keypair is saved.

The suite creates a classic SPL mint with supply one and zero decimals, seller ATA, genuine
Metaplex metadata with zero royalties/no creators, and a non-printable master edition. It
decodes metadata to verify the mint and NonFungible standard, then calls the official SDK's
ListLegacy instruction against real Tensor. It decodes the resulting listing to assert the
seller, original mint, price, public SOL currency and absence of brokers/cosigner requirements.
The real fee PDA receives only local rent funding, as in Tensor's fixture strategy.

It uses existing backend instruction encoders to create a new owner-derived GoBuy mandate,
Vault and explicit owner-signed original-NFT authorization. The normal budget is 500,000,000
lamports and listing price 100,000,000 lamports. Every order is a fresh 16-byte value.
Fixture JSON records public addresses and the confirmed owner-authorization signature.

SDK construction was reviewed against the installed declarations and Tensor's
[legacy buy](https://github.com/tensor-foundation/marketplace/blob/8be7f2c3d60c18871e0913b5f837408eeb69047d/program/src/instructions/legacy/buy.rs)
and [list](https://github.com/tensor-foundation/marketplace/blob/8be7f2c3d60c18871e0913b5f837408eeb69047d/program/src/instructions/legacy/list.rs)
sources. Runtime assertions, not this review, decide whether the deployed binaries agree.

## PURCHASE_TRANSACTION

**NOT EXECUTED. No transaction signature or CPI logs are available.**

Implemented assertions require a confirmed successful GoBuy purchase transaction, with only
the fresh executor signing/paying outer fees. The SDK's only BuyLegacy signer is slot 7; its
Vault PDA signer flag is removed in the outer instruction and restored by GoBuy's existing
`invoke_signed`. CPI evidence requires GoBuy at invocation depth 1, Tensor at depth 2,
BuyLegacy logs and exactly one matching inner BuyLegacy instruction. Its payer, buyer,
destination, mint, listing and seller indices must match the fixture.

Complete confirmed transaction JSON, message account roles, signer public keys, inner
instructions, submission signatures, error status and logs are saved for setup and test
transactions. Failed cases are actually submitted locally with preflight skipped, so a
simulation alone cannot satisfy rollback assertions. Unique compute-limit instruction bytes
avoid the duplicate-order case accidentally retrieving an already processed signature.

## NFT_DELIVERY

**NOT TESTED.** The implemented positive case requires one token in Tensor's listing ATA
before purchase, zero in the seller ATA, and no buyer ATA. After purchase the original mint
must be in the owner's canonical ATA with amount one, and the listing/escrow ATA must close.
The mint account must remain identical, ruling out a replacement mint after payment.

## PAYMENT_ACCOUNTING

**NOT VERIFIED.** Before/after snapshots contain raw account bytes, owners and lamports,
plus decoded mandate, authorization, receipt and SPL token balances.

For the zero-royalty/no-broker fixture, assertions require:

- Vault debit = listing price + expected 2% Tensor fee + buyer ATA rent.
- Fee PDA increase = Tensor fee; inner System transfer pays the listing price from Vault
  directly to seller. Seller increase also includes refunded listing and escrow-ATA rent.
- Both mandate and authorization spending increase by the measured Vault debit; limits
  remain the approved amounts. Owner SOL is unchanged during purchase.
- Executor debit = transaction fee + receipt rent, accounted separately from Vault payment.
- Exactly one receipt for this mandate, with the expected mint, order, listing, marketplace,
  owner, executor, authorization, price and measured debit.

Pricing is an asserted expectation, not a dynamically accepted debit. A protocol fee change
must fail the test and be reviewed. No successful outcome is inferred from these assertions.

## NEGATIVE_TEST_RESULTS

All cases are implemented. Current integration results are **0/9 negatives passed**;
the positive case is also blocked. The suite stops on first failure, retaining the failure
and marking later cases blocked instead of claiming they passed.

| Case | Current result | Runtime proof required |
| --- | --- | --- |
| Valid purchase | BLOCKED | Original delivery, real CPI, signer/accounting/receipt assertions |
| Invalid listing | BLOCKED | Noncanonical listing rejected with InvalidListing before Tensor |
| Wrong mint | BLOCKED | Instruction mint mismatch rejected with InvalidListing |
| Unauthorized executor | BLOCKED | InvalidOwner before Tensor CPI |
| Expired authorization | BLOCKED | Wait for local Clock expiry; PurchaseAuthorizationExpired |
| Insufficient mandate budget | BLOCKED | BudgetExceeded before Tensor CPI |
| Insufficient authorization budget | BLOCKED | Successful Tensor CPI, then PurchaseAuthorizationBudgetExceeded and atomic rollback |
| Duplicate order | BLOCKED | Receipt initialization rejects replay; original receipt/debit unchanged |
| Invalid destination | BLOCKED | Seller ATA substituted; InvalidBuyerTokenAccount before Tensor |
| Transaction rollback | BLOCKED | GoBuy/Tensor success followed by an unfundable System transfer; all purchase state restored |

Every failed purchase must preserve all tracked accounts except the actual fee payer's
transaction fee. This includes listing tokens, mint, Vault, both budgets, seller, destination
and receipt. The final rollback deliberately fails the instruction after GoBuy, checking its
instruction index and successful GoBuy/Tensor logs before comparing pre/post state.

Invalid destination tests GoBuy's protocol constraint. It does not claim coverage of a
malicious Tensor returning success without delivery, nor of GoBuy's post-CPI delivery guard.
There are no mock marketplace substitutions or fabricated listing accounts.

Local checks passed: both script syntax checks, workflow YAML/opt-in/upload checks, official
SDK instruction construction, serialized signed transaction packet-size checks, 13 existing
purchase unit tests, source-tree equality and `git diff --check`. Offline tests are not
included in the integration counts. `tsx` initially hit the sandbox user-profile error; the
authorized offline rerun passed. No local transaction was submitted.

## REMAINING_BLOCKERS

1. Windows has no validator; this local execution attempt stopped before fixture creation.
2. The Step 7 workflow change has not been published or dispatched. This session has no
   authenticated GitHub execution tool; public API reads cannot dispatch it. No credentials
   were accessed. Step 6 success does not establish Step 7 success.
3. First-run fixture/runtime compatibility and actual assertions remain unverified. Any
   failure must be diagnosed from the real confirmed transaction/validator evidence.
4. Public RPC snapshot availability and retained build artifacts remain external dependencies.

## FILES_CHANGED

- `scripts/tensor-local-e2e.mjs`: genuine local fixture, purchase, nine negatives and evidence.
- `scripts/tensor-local-preflight.mjs`: opt-in suite call while its verified child validator
  remains alive; keeps existing startup/probe/cleanup behavior.
- `.github/workflows/tensor-integration.yml`: default-off Step 7 input, source-tree check,
  locked dependencies, execution status and always-uploaded public Step 7 JSON/log evidence.
- `docs/TENSOR_INTEGRATION_STEP7.md`: this implementation and verification report.
- `docs/TENSOR_INTEGRATION_STEP6.md`: current passing preflight pointer, retaining history.
- `docs/evidence/step7/local-preflight.json`: actual blocked local attempt, hashes and slots.
- `docs/evidence/step7/status.json`: machine-readable current verification status.

No Anchor program, ID, seeds, layout, backend/frontend behavior, lockfile, existing Anchor CI,
live flag, historical account/order or wallet logic was changed. No remote deployment,
upgrade or transaction occurred.

## NEXT_STEPS

Publish the harness and manually start a **new** run of `tensor-integration.yml` with
`build_run_id=37964523776`, `step7=true`, and incremental startup enabled. The workflow name
remains the existing prerequisite name for continuity; Step 7 is the explicit opt-in input.
Download its `tensor-integration-prerequisites` artifact, including `docs/evidence/step7/`,
and inspect the runtime `report.json` plus confirmed transaction/state evidence. The first
run is verification, not a guaranteed pass. Keep production purchasing disabled.

If Rust changes are necessary, rebuild through unchanged Anchor CI and supply that new run
ID; the source-tree check rejects stale artifacts. Claim full success only after all ten
cases pass with the required original-NFT GoBuy-to-Tensor CPI evidence.
