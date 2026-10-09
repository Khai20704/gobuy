# Step 7: real GoBuy to Tensor CPI tests

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
