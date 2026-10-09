# Step 6: real Tensor integration gate

## Step 6.1: startup diagnostics (current status)

### ROOT_CAUSE

**Confirmed root cause from the GitHub Actions error supplied by the user:**

```text
Invalid value for '--dynamic-port-range <MIN_PORT-MAX_PORT>': Port range is too small. Try --dynamic-port-range 19000-19025
```

The configured `19000-19020` range was rejected during CLI argument validation.
It is now `19000-19050` in the shared startup arguments, covering both baseline and
incremental program stages. This fixes the confirmed configuration error; successful
validator startup and Tensor execution still require a new GitHub Actions run.

Earlier investigation:
Run [37967999612](https://github.com/Khai20704/gobuy/actions/runs/37967999612)
failed at the preflight step on commit `395005dce400eadf853942ddfb0d69c9be72b12f`.
The public jobs API confirms artifact download, identity/checksum verification and Agave
installation succeeded, followed by preflight failure. The user-provided report confirms
five snapshots succeeded and the validator exited before the dispatch probe.

A **diagnostics defect** is confirmed independently: Agave v3.0.14's
[CLI source](https://github.com/anza-xyz/agave/blob/v3.0.14/validator/src/bin/solana-test-validator.rs)
redirects stderr to a timestamped log inside the ledger unless `--log` is supplied.
The old script captured process stdout/stderr but omitted that flag and did not preserve
ledger logs. Consequently, its generic startup error could hide the actionable runtime error.
This explains the earlier missing diagnostics; the supplied error now identifies the port-range failure.

### VALIDATOR_LOG_EVIDENCE

Artifact `tensor-integration-prerequisites` (ID `11633234877`) was uploaded successfully.
Attempts to retrieve it through the unauthenticated GitHub API returned HTTP 401; job-log
download for job `113947134940` returned HTTP 403. No downloaded validator log was found
locally. The actual previous stdout/stderr, exit code, signal and ledger log have therefore
**not been examined directly**. The exact port-range error above was subsequently supplied
by the user from GitHub Actions. No CPU, memory or binary compatibility failure is established.

### FIX_APPLIED

Current fix: change the sole executable occurrence of `19000-19020` to `19000-19050`.
No duplicate range was found in the integration workflow or related scripts.
Agave version, program bytes and IDs remain unchanged. Existing diagnostics and verification
are preserved:

- Add `--log` so complete stdout and runtime stderr share the uploaded `validator.log`.
- Record each attempt's public command arguments, program paths/hashes, timestamps, PID,
  exit code, signal, cleanup signal and spawn errors. No environment or wallet configuration
  is recorded; all arguments are constructed from fixed flags, local paths and public IDs.
- Preserve allowlisted ledger `validator*.log` files, never ledger keypair JSON or databases.
- Enforce a 90-second startup deadline with at most 2 seconds per RPC health request;
  retain every health result/error and the genesis hash on success.
- Record the first error-like log line as a **candidate**, plus a log tail; neither replaces
  review of the complete log. Detect signal exits as well as numeric exit codes.
- Default the manual workflow's `incremental_startup` input to true: fresh baseline with no
  custom programs, then cumulative GoBuy, Tensor, Metadata, Authorization Rules, SPL Token,
  and finally ATA. Each stage uses a fresh ledger and stops its child before the next starts.
  The baseline still includes Agave's built-in programs. Stop on the first failing stage.
- Once full startup succeeds, verify all six executable accounts at their intended IDs and
  compare loaded program byte hashes against the source artifact/snapshots. Executable flags
  alone no longer establish that the intended bytes were loaded.
- Retain `if: always()` artifact upload; print diagnostic tails on failure and report
  `validatorStarted`, `genuineProgramsLoaded`, `tensorDispatchExecuted` separately.

Compatibility review: v3.0.14's CLI accepts `--bpf-program` and creates upgradeable program
accounts. Its [genesis implementation](https://github.com/anza-xyz/agave/blob/v3.0.14/test-validator/src/lib.rs)
inserts supplied bytecode after the ProgramData header, replacing matching built-in entries.
Thus ATA's remote older-loader format is deliberately loaded locally through the existing
upgradeable loader path; its ELF bytes remain unchanged. This source review does **not** prove
SBF instruction/feature compatibility. The incremental run and dispatch logs must establish
what executes. Program-account loading also does not prove every dependency can execute its
instructions. No binary patch, feature deactivation or version bump was applied speculatively.

### FILES_CHANGED

This port-range fix changes only `scripts/tensor-local-preflight.mjs` and
`docs/TENSOR_INTEGRATION_STEP6.md`. The integration workflow required no edit.
Existing successful Anchor CI, program code, Program ID, PDA seeds, wallet logic and
purchasing logic remain untouched. The earlier diagnostics change also edited the integration workflow.

### LOCAL_CHECKS

- JavaScript syntax, workflow YAML parsing, default incremental input and always-upload checks passed.
- For the port-range fix: syntax and workflow validation were rerun; searches found no
  remaining invalid range in executable scripts/workflows. The script diff contains only
  the requested range replacement, preserving all existing diagnostics and verification.
- Five temporary process-wrapper checks passed: healthy, numeric exit, signal exit, startup
  timeout and spawn error; log preservation excludes keypair files. These use test doubles
  for subprocess/RPC behavior and are **not Solana or Tensor integration tests**.
- `git diff --check` passed. Local validator execution remains unavailable.

### CI_VERIFICATION_STATUS

**Port-range fix unverified on Linux CI; no rerun was dispatched.** This session has no
authenticated GitHub dispatch capability and has not accessed credentials or repository secrets.

| Outcome | Status |
| --- | --- |
| Validator started successfully | NOT VERIFIED; previous run failed startup |
| Genuine programs loaded locally | NOT VERIFIED; snapshots alone are insufficient |
| Tensor BuyLegacy dispatch executed | NOT EXECUTED |
| Full GoBuy CPI purchase | NOT EXECUTED; outside Step 6.1 |

### REMAINING_BLOCKERS

The local machine has no validator. The confirmed argument error is fixed in source, but
startup, loaded-bytecode verification and runtime compatibility remain unverified until the
revised Linux run completes. Other startup failures, if any, must be diagnosed from that run.

### NEXT_STEPS

Publish these changes and start a **new** manual Tensor preflight using build run
`37964523776`, leaving incremental startup enabled. Rerunning the old failed job uses its old
workflow revision and will not test these changes. Inspect the first failed stage's
`*-startup.json`, complete validator log and any ledger log in the always-uploaded artifact.
If baseline fails, investigate validator/environment setup; if a cumulative stage first fails,
investigate that addition and its interactions without assuming causation from ordering alone.
Apply the smallest evidence-backed fix, then repeat. Once all stages pass, run only the
existing unsigned genuine BuyLegacy missing-account dispatch probe, never a purchase.

---

The original Step 6 investigation below is historical. Its statement that the workflow was
not yet published/executed is superseded by the failed run and Step 6.1 status above.

## TEST_ENVIRONMENT

Investigation: 2026-10-10 Asia/Saigon (2026-10-09 UTC). Windows workspace has Node,
but no `solana-test-validator`, Solana CLI or GitHub CLI. No validator was started.

GitHub's public API confirmed [Anchor CI run 37964523776](https://github.com/Khai20704/gobuy/actions/runs/37964523776)
concluded `success`, source commit `868d35fbc3818ceab5b0cd023773be62a7e36d3f`.
Artifact `anchor-program-sbf`, ID `11632743767`, was not expired when checked.
The locally downloaded ELF is 298456 bytes, SHA-256
`9c092a8d33903079f73d3ede303e71ea29ece86ff14f2f08a7f2d548943c902f`.
Its embedded program ID check passes for `CHjdqooB7TrussJoZoboFP5TtdCspoHtvPpqoshbr5zE`.
This local identity check alone does not authenticate artifact provenance. The new workflow
downloads the selected successful build's artifact and checks its original checksum manifest.

Separate manual workflow: `.github/workflows/tensor-integration.yml`, Ubuntu, Agave v3.0.14,
matching the existing build workflow. It uses the compiled artifact without rebuilding.
It records build and harness commits separately. Existing `anchor-ci.yml` is unchanged.

## TENSOR_PROGRAM_AVAILABILITY

**Real binaries available; local execution not yet verified.** Public Mainnet RPC was used
only for `getAccountInfo`. No transaction was sent or simulated remotely.

The completed snapshot report is [step6-availability.json](evidence/step6-availability.json).
It records program addresses, ProgramData addresses, observation slots, deployment slots,
byte lengths, and SHA-256 hashes for Tensor, Token Metadata, authorization rules, SPL Token
and Associated Token. All five ELF snapshots succeeded. ATA uses the older BPF loader;
the others use the upgradeable loader. Snapshot acquisition is sequential, not a single-slot
bank snapshot; future runs capture new hashes and must not assume unchanged deployed code.

Tensor SHA-256: `f8b67c44f18d44a35695e20e41e200fe3d1282e335dc4c63674c34b1bcdb2a42`.

Tensor's [official validator harness](https://github.com/tensor-foundation/marketplace/blob/8be7f2c3d60c18871e0913b5f837408eeb69047d/scripts/start-validator.mjs)
loads real binaries using `--bpf-program` and fixtures using `--account`.
Its [program dependency manifest](https://github.com/tensor-foundation/marketplace/blob/8be7f2c3d60c18871e0913b5f837408eeb69047d/program/Cargo.toml)
also covers other asset standards and escrow paths. Our five-program probe is scoped to the
classic legacy NFT path, not all Tensor functionality. The [official legacy tests](https://github.com/tensor-foundation/marketplace/blob/8be7f2c3d60c18871e0913b5f837408eeb69047d/clients/js/test/legacy/buy.test.ts)
provide a fixture strategy using real listing instructions. These sources support feasibility;
they do not prove compatibility of today's deployed binaries with Agave v3.0.14 or GoBuy.

## INTEGRATION_TESTS_IMPLEMENTED

Implemented **prerequisite probe only**, not the full purchase suite:

- Read-only, fixed-endpoint program snapshots; loader and ELF checks; hashes and slots.
- Fresh temporary ledger, fixed loopback RPC, refusal to attach to an occupied RPC port,
  loading the existing GoBuy artifact and actual downloaded programs at their original IDs.
- Local executable-account checks and an unsigned, direct Tensor BuyLegacy simulation with
  missing accounts. Expected `BuyLegacy` / `AccountNotEnoughKeys` logs prove dispatch only.
- Public JSON/log evidence upload, process cleanup, and explicit `BLOCKED_NOT_EXECUTED`
  purchase status even when the prerequisite job passes.

There is no mock marketplace or successful-purchase substitute. No wallet file is read.
The simulation uses a random public address funded in local genesis and zero signature bytes,
with `sigVerify: false`; this cannot prove user authorization or Vault PDA signing.

## INTEGRATION_TEST_RESULTS

| Category | Result |
| --- | --- |
| Existing host unit/layout tests | `node --import tsx --test backend/tests/nftPurchase.test.ts`: 13/13 passed |
| Tensor SDK/source constant checks | 88/88 passed |
| Local compiled ELF identity | Passed |
| Probe JS syntax and workflow YAML parsing | Passed |
| Remote genuine-program snapshots | 5/5 succeeded |
| Local Tensor dispatch | BLOCKED: validator executable absent |
| Mock-based CPI tests | None added or claimed |
| Real GoBuy Tensor CPI purchase | NOT IMPLEMENTED / NOT EXECUTED |
| Linux workflow execution | NOT EXECUTED; local workflow file only |

The unit-test command initially failed in the sandbox during `uv_os_get_passwd`, before
tests ran; the authorized rerun outside the sandbox passed. No unit result is counted as CPI
coverage. `git diff --check` also passed.

Required validator cases remain gated, not silently skipped as passing:

| Case | Required future assertion | Current result |
| --- | --- | --- |
| Full purchase | Fresh owner signs authorization; executor signs purchase; nested Tensor invocation; Vault debit; same mint in owner ATA; both budgets; decoded receipt | Blocked / not implemented |
| Invalid listing | Reject nonexistent/noncanonical listing; no receipt or state changes | Blocked / not implemented |
| Wrong mint | Reject mint/listing mismatch; preserve ownership and budgets | Blocked / not implemented |
| Unauthorized agent | Exact signer constraint error before Tensor CPI | Blocked / not implemented |
| Expired authorization | Advance local clock/wait for expiry; exact authorization error | Blocked / not implemented |
| Insufficient budget | Separate mandate and authorization ceilings; unchanged state | Blocked / not implemented |
| Duplicate order | Replay successful order; receipt unchanged; no second debit | Blocked / not implemented |
| Failed delivery | Genuine wrong/frozen destination fixture; assert actual error and stage | Blocked / not implemented |
| Transaction rollback | Successful CPI followed by a deliberately failing instruction in the same transaction; all purchase state restored | Blocked / not implemented |

A failed Tensor transfer does not exercise GoBuy's post-CPI delivery guard. If genuine Tensor
cannot produce a bad delivery while returning success, that guard remains a unit-test property;
do not use a mock to claim real-Tensor coverage. Failed on-chain transactions can still charge
the fresh executor a transaction fee; rollback assertions must account for that separately.

## TRANSACTION_EVIDENCE

**None.** No transaction signatures, CPI logs, token ownership changes, Vault balances or
receipt PDAs exist from this investigation. The committed JSON is RPC availability evidence,
not transaction evidence. A future Linux preflight can emit `validator.log`, local executable
account snapshots, genesis hash and `buy-legacy-dispatch-simulation.json`; those still do not
prove purchase integration. No existing Vault, historical order or listing was accessed.

For full integration, retain pre/post raw and decoded mandate, authorization, Vault, listing,
mint, seller ATA, owner ATA and receipt accounts, transaction message/signers, `meta.err`,
inner instructions, logs, fees and pre/post balances. Require both the nested Tensor program
invocation and final ownership/accounting assertions before declaring success.

## FILES_CHANGED

- `scripts/tensor-local-preflight.mjs`: real program snapshot/local dispatch probe.
- `.github/workflows/tensor-integration.yml`: isolated manual Linux prerequisite workflow.
- `docs/evidence/step6-availability.json`: executed snapshot result and local blocker.
- `docs/TENSOR_INTEGRATION_STEP6.md`: this report and remaining acceptance matrix.
- `docs/CPI_VERIFICATION.md`: current status pointer above the historical Step 5 report.

## BLOCKERS

1. No local Solana validator. All retrieved program binaries remain unexecuted here.
2. The separate workflow exists only in the workspace; no authenticated GitHub execution
   capability is available in this session. A public API read cannot dispatch a workflow.
3. Real legacy listing fixtures and the full purchase/failure harness remain unimplemented.
   Dependency snapshots are necessary but do not establish complete runtime compatibility.
4. Public RPC limits and deployment changes may block later snapshot acquisition; failures
   produce a nonzero exit and explicit blocked report, never a mock fallback.

## NEXT_STEPS

Smallest safe alternative: publish this separate prerequisite workflow and manually run
**Tensor integration prerequisites (no purchase claim)** with build run `37964523776`.
Review its real local dispatch evidence before extending it to purchases. No change to the
existing passing build is needed.

Once local loading is demonstrated, create a fresh seller-owned classic Metaplex NFT and a
genuine Tensor ListLegacy listing entirely locally (zero royalties, no cosigner/brokers as the
first supported fixture). This is an original local test NFT transferred by Tensor, not a DEMO
fallback NFT minted after a supposed purchase. Use fresh in-memory local-only signers and a
new owner-derived mandate/Vault/order. Then implement the acceptance matrix above against
the existing GoBuy instructions. Never import an existing wallet, funded Vault or order.

No Devnet deployment/upgrade, Mainnet transaction, live purchase flag, DEMO fallback,
program ID or PDA seed change occurred. Full end-to-end success is **not claimed**.
