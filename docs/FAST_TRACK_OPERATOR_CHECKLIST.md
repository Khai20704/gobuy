# Controlled Devnet demo — operator checklist

**Not executed. No signing, funding, upgrade or live enablement is authorized by this checklist.**
Current machine: Windows PowerShell + Node 24; no Solana CLI and no installed WSL distribution.
Application tests use generated in-memory fixture keys only. Never paste/export an authority private key.

## 1. Offline checks on this machine

Run from `C:\Users\khait\OneDrive\Desktop\Gobuy\gobuy`:

```powershell
$targetElf = 'C:\Users\khait\Downloads\anchor-program-sbf\anchor\target\deploy\gobuy_na.so'
node scripts/verify-sbf-program-id.mjs $targetElf CHjdqooB7TrussJoZoboFP5TtdCspoHtvPpqoshbr5zE
git rev-parse HEAD:anchor
git rev-parse 868d35fbc3818ceab5b0cd023773be62a7e36d3f:anchor
git diff --exit-code -- anchor .github/workflows/anchor-ci.yml
node docs/evidence/step8/verify-evidence.mjs
npm test
npm run lint
npm run build -w backend
npm run build -w frontend
node scripts/verify-tensor-constants.mjs
npx playwright test --config playwright.genuine.config.ts
```

Both Anchor trees must equal `66710f1c08529ff6414456be8c35e13a833f066e`.
ELF: **298456 bytes**, SHA-256 **9c092a8d33903079f73d3ede303e71ea29ece86ff14f2f08a7f2d548943c902f**.
Source/build provenance: build **37964523776**, source **868d35fbc3818ceab5b0cd023773be62a7e36d3f**.
The supplied PASS integration archive lacks its own run ID; retain/identify its original GitHub run URL
for operator review. Do not mistake the build run for the integration run.

## 2. Fresh read-only baseline

Quiesce purchasing and retain both flags as false: `NFT_PURCHASE_LIVE_ENABLED` and
`GOBUY_DEMO_AUTOPURCHASE_ENABLED`. This task has not edited environment files or enabled either flag.
Use a new output path for every capture; keep the original Step 8 snapshot unchanged.

```powershell
$baselinePath = 'docs/evidence/fast-track/before-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.json'
node docs/evidence/step8/read-devnet.mjs $baselinePath
$snapshot = Get-Content -Raw -LiteralPath $baselinePath | ConvertFrom-Json
$snapshot | Select-Object genesis, program, programData, authority, deploymentSlot, payloadBytes, payloadSha256
$snapshot.rent
$snapshot.authorityBalance
```

Expect Devnet genesis `EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG`, ProgramData
`GocAbEB3CrykEu5wTyZ4w888cQn2krEtuuEiMJGwqGek`, authority
`6CndRMc647mRNyFLTXVefngq7kgouexvoVP6v4aZQ6JB` and old payload hash
`2fe02be44d7ac3e2d0f05c04de29d5937bacad085039d5c924cb4b5785fc4a59`.
The full old binary bytes are retained inside ProgramData base64 for recovery.

Observed minimums: ProgramData 298501 bytes, **94,447,360 lamports** top-up; buffer 298493 bytes,
**1,516,994,680 lamports** temporary rent, plus fees. Re-query for the CLI's actual allocation;
spare-capacity allocation costs more. Authority observed balance: **10,345,547,689 lamports**.
Equal live account layouts/PDA derivations support compatibility, but old deployed-source equivalence
has not been established. No user-account migration/reset is proposed.

## 3. Prepare the operator environment and signer — stop before signing

Prepare a Linux operator environment with **Agave 3.0.14** (same pinned version as CI), or an explicitly
reviewed compatible CLI. This Windows machine cannot currently run a verified CLI deployment command.
On that environment, inspect without signing:

```sh
solana --version
solana program deploy --help
solana program write-buffer --help
solana program extend --help
solana --url https://api.devnet.solana.com genesis-hash
solana --url https://api.devnet.solana.com program show CHjdqooB7TrussJoZoboFP5TtdCspoHtvPpqoshbr5zE
```

Operator must identify a supported signer URI/device controlling the exact authority. A funded address
or wallet screenshot is not sufficient. With separate signing approval, sign a fresh nonce message bound
to this Program ID, Devnet genesis and expiry; verify its signature offline. Identify payer and refund
recipient and review allocation/fee caps. No signer URI or private key is supplied by this repository.

The following is a **future Linux command template**, not runnable on the present machine, and must
be reconciled with the installed CLI help and signer URI before upgrade approval:

```sh
solana --url https://api.devnet.solana.com program deploy /absolute/path/gobuy_na.so \
  --program-id CHjdqooB7TrussJoZoboFP5TtdCspoHtvPpqoshbr5zE \
  --upgrade-authority '<APPROVED_AUTHORITY_SIGNER_URI>' \
  --fee-payer '<APPROVED_PAYER_SIGNER_URI>'
```

**This sends transactions and spends SOL. Do not execute now.** Confirm that the chosen deploy path
uploads/verifies the buffer and extends existing allocation as needed, recording all signatures,
buffer addresses, funding and recovery destinations. Never use a new Program ID or revoke authority.
If an explicit extension is needed, its size/funding and command need inclusion in the reviewed approval.
The exact authority/payer binding is a remaining blocker, not an assumed default wallet.

## 4. Post-upgrade read-only checks

Only after the separately approved operator upgrade, return to PowerShell with the retained `$baselinePath`:

```powershell
$afterPath = 'docs/evidence/fast-track/after-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.json'
node docs/evidence/step8/read-devnet.mjs $afterPath
node scripts/verify-devnet-upgrade.mjs $baselinePath $afterPath $targetElf
```

Verifier fails unless ProgramData slot advances, exact target ELF prefix/hash matches, authority/program
identity stay fixed, and all historical accounts and old Vault are unchanged. Separately reconcile payer
fees/rent and recovered buffer funds. Keep live execution disabled throughout this verification.

## 5. One controlled original-NFT smoke test — separate approval required

1. Use a **separate test wallet** and funded executor. Leave old mandate
   `7gfmi99mSw52BDyCroKvYAXmVguLVKSGHqLBhFQacABB`, old Vault and five receipts untouched.
2. In Na, connect Phantom, verify wallet linkage and select Devnet. Create a small short-lived Na Vault
   through the existing budget panel after owner funding/signing approval.
3. Ask to buy an NFT with a SOL limit. Confirm an actual supported Tensor Devnet listing appears;
   if none exists, stop. Review mint, seller, listing price and total ceiling. No hardcoded catalog or DEMO fallback.
4. Click the separate NFT authorization button. Its ceiling is price + 5% + 5,000,000 lamports,
   with at most one hour validity, capped by mandate expiry. It permits marketplace purchases within
   that budget; it is not an on-chain per-mint restriction. Confirm the finalized authorization readback.
5. After explicit live/spending approval, restrict access to one operator and one order; quiesce other
   workers. Temporarily enable the existing live flag and reload/verify the backend configuration.
   Preflight checks the 200,000-CU transaction; do not automatically raise limits/retry on rejection.
6. Click **Mua NFT gốc trên Devnet** once. Immediately disable live execution after the controlled
   attempt and verify the running backend reloaded it. UI remains pending until finalized receipt and
   transaction token-delivery evidence match. A dropped response only triggers status polling.
7. Save original signature, receipt, ATA/mint, both counter deltas, Vault debit, seller/fee transfers,
   executor fee/receipt rent and final snapshots. Re-run the post-upgrade verifier against old accounts.
   Do not call this a successful Devnet purchase until those checks pass.

## Recovery

Missing receipt/null status/transport timeout stays pending. Reconcile the **original** order/signature;
do not generate another discovery to retry. A crash after durable reservation but before broadcast may
leave a deliberately blocked RESERVED order; manual diagnosis is required, not automatic resubmission.
Authorization submission similarly retains the original signature across reloads; unresolved expiry
requires operator diagnosis. Definitive finalized failure can be reviewed separately.

Binary rollback is another approved upgrade using saved old bytes, not restoration of account state.
It cannot undo purchases; old code cannot manage new authorization/receipt accounts. Plan owner revocation
before rollback and preserve all receipts. Buffer/extension transactions can have succeeded even if final
upgrade failed; inspect them before any cleanup. See [the full recovery plan](DEVNET_UPGRADE_PLAN.md#10-recovery-and-rollback).
