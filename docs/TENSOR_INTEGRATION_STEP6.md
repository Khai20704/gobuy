# Step 6: real Tensor integration gate

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
