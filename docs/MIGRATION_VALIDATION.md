# Migration validation — 2026-10-04

- `npm test`: **168 passed, 0 failed, 0 skipped**. Includes nine new Helius/Tensor migration regression tests.
- `npm run lint`: **passed**, exit 0. Repository lint scripts run TypeScript no-emit checks for all workspaces and `tsc -p tsconfig.tests.json` for test code.
- Typecheck: **passed** through the above workspace and test checks.
- `npm run build`: **passed**, exit 0, including shared, Tensor adapter, backend, frontend and extension. Nonfatal Vite warnings remain for a large frontend bundle and dependency annotation cleanup.
- `git diff --check`: **passed**. Existing Windows line-ending notices are nonfatal.
- First sandbox test/build attempts were blocked by Windows profile access and esbuild directory permissions; approved runs outside the sandbox completed. Intermediate assertions/import errors were resolved before the final passing run.

Read-only live diagnostic: `node --env-file=backend/.env scripts/check-nft-devnet.mjs`.
Configured Helius returned **HTTP 401**, so live Helius metadata verification and end-to-end purchase remain blocked. Independent public Devnet RPC confirmed Tensor listings (example and scan counts in NFT_BUY_IMPLEMENTATION.md). No transaction was sent and no autonomous execution is claimed.

Raw command outputs are `.migration-tests.log`, `.migration-lint.log` and `.migration-build.log` in the local repository root. They contain no Helius API key.
