# Step 8 evidence

Captured/reviewed 2026-10-10 Asia/Saigon. Public data only; no signatures generated or transactions sent.

- `step7-pass/`: 283 JSON files copied byte-for-byte from the supplied Downloads archive.
  Original relative paths use `__` instead of `/`. Historical status/local-preflight files in that
  archive describe older attempts; the runtime `docs__evidence__step7__report.json` records PASS.
- `artifact-manifest.json`: original ZIP SHA-256 and per-file hashes. Supplied archive provenance
  is retained; the PASS integration run ID was not independently authenticated against GitHub.
- `verify-evidence.mjs`: offline assertions against raw transactions, account bytes, rollback
  states, fee payer, delivery, counters, receipt fields and live-snapshot PDA derivations.
  Run from repository root: `node docs/evidence/step8/verify-evidence.mjs`.
- `verification-results.json`: successful offline check, 1 positive and 9 negative cases.
- `read-devnet.mjs`: public read-only RPC reader; writes `devnet-snapshot.json`. Archive the old
  snapshot before rerunning. No wallet/env/signing or transaction submission code.
- `devnet-snapshot.json`: finalized RPC responses, full ProgramData, program-owned accounts,
  Vault, authority balance and rent quotes. Calls have individual context slots.

Additional checks: existing `backend/tests/nftPurchase.test.ts` passed **13/13**; local downloaded
ELF passed `scripts/verify-sbf-program-id.mjs` with 298456 bytes and SHA-256
`9c092a8d33903079f73d3ede303e71ea29ece86ff14f2f08a7f2d548943c902f`.
Git independently matched the build/harness Anchor trees and Anchor CI workflow blob.
The submit buffer offset defect was reproduced as `ERR_OUT_OF_RANGE`; production code remains unchanged.
No new validator E2E, SBF rebuild or Devnet purchase was run.
