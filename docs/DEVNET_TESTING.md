# Devnet development and verification

Account onboarding is now required before opening Na or calling its purchase API. See [account setup](ACCOUNTS.md). Use `npm run dev:auth` for local emulator accounts. The browser suite now runs with `npx playwright test --config playwright.auth.config.ts` and a running Auth emulator; the earlier unauthenticated browser command below describes the pre-account audit.

GoBuy accepts only Devnet in every build, including production builds. There is no Mainnet execution flag. A future network rollout requires a reviewed code change.

## Current Tensor + Helius purchase path

Set `HELIUS_API_KEY` and `HELIUS_NETWORK=devnet` in `backend/.env`; keep the key out of
root/frontend `.env` files and all `VITE_*` variables. Tensor's official on-chain
integration needs no Tensor API key. Restart the backend and confirm the authenticated
`GET /api/acquisition/config` response reports `marketplaceProvider: "tensor"`,
`assetProvider: "helius"`, `heliusConfigured: true`, `executionNetwork: "devnet"` and
`autonomousSigning: false`. The response must not contain the API key.

To search, use a request such as `Tìm tranh NFT dưới 1 SOL`; this must return ranked
listings without preparing or submitting a transaction. To prepare a purchase, explicitly
request `Mua tranh NFT dưới 1 SOL đáng mua nhất`, connect Phantom on Devnet, and sign an
NFT spending policy. Review the current Tensor listing, mint, seller, price and total
estimated spend in the quote. Phantom is asked to sign only after you choose to proceed.
After signing, wait for `/orders/:id` to report `CONFIRMED` and verify the NFT is in the
buyer wallet. `READY`, a constructed instruction, or a submitted-but-unconfirmed
transaction is not purchase success. Do not use Mainnet funds or a Mainnet RPC.

Automated tests use mocks for Helius and Tensor RPC/DAS behavior; they do not perform a
live purchase. A manual signed Devnet purchase remains opt-in and has not been completed
in the current verification run.

## Configuration and startup

From `gobuy`, install dependencies with `npm ci` if needed. Copy `frontend/.env.example` to `frontend/.env.local`. Merge these settings into the existing `backend/.env` without replacing API keys:

```dotenv
SOLANA_NETWORK=devnet
SOLANA_RPC_URL=https://api.devnet.solana.com
```

Use the same settings in the frontend file. Vite exposes only the two public Solana settings under their internal `VITE_SOLANA_*` names. Other backend secrets are not exposed. Vite reads root and frontend environment files; backend scripts load `backend/.env`. Shell variables take precedence. Defaults are Devnet. Conflicting legacy `VITE_SOLANA_RPC_URL`, `NFT_DEMO_RPC_URL`, or `SOLANA_DEVNET_RPC_URL` values fail closed; migrate custom RPCs to `SOLANA_RPC_URL` in both workspaces.

Run from `gobuy` (starts both services):

```sh
npm run dev
```

Open the URL printed by Vite, normally `http://localhost:5173/na`. Backend normally listens on port 3001.
For separate terminals use `npm run dev:backend` and `npm run dev:frontend`.

## Historical simulation-flow audit (2026-10-01; before Tensor)

The following dated results describe the prior demo-catalog/simulation flow. They are
not evidence of a Tensor marketplace purchase or current live-provider availability.

- `npm run dev` now starts both backend and frontend. Live health checks passed directly and through the frontend proxy. API errors distinguish an unavailable/invalid backend response from a server-provided error, and unsigned failed requests remain in the input for retry.
- Budgets accept SOL, `5 đô`, `5 đô la`, `5 USD`, and `$5`. USD uses the existing fresh SOL/USD rate provider as a reference only; no real USD is charged and Devnet SOL has no real cash value. Conversion rounds down (strictly below for “under/dưới”), preserves a 10 SOL demo ceiling, includes the estimated fees, and rechecks the USD limit before submission. Missing/stale rates stop preparation. No matching art means no purchase; the gallery is not a live external NFT marketplace.
- 91 unit/API tests, three Chrome browser tests, all workspace type checks and builds passed. Tests cover budget parsing, unknown/unsupported requests, insufficient balance, unsigned/tampered transactions, repeated submission, uncertain submission, wallet rejection, confirmed receipts, balance refresh and Devnet Explorer links. Browser confirmation/balance changes are mocked; they are not live chain results.
- A live Devnet quote for Blue Tide passed transaction simulation: 200,000,000 lamports item price, 202,917,000 lamports estimated total. The provided public wallet remained at 5,000,000,000 lamports before and after preparation. No transaction from that wallet was signed or submitted.
- A live purchase test with an ephemeral wallet was blocked by the faucet's HTTP 429 before signing/spending. The rate service also returned data outside the existing freshness window during testing; USD requests correctly returned NEEDS_INPUT. The full live debit/receipt/ownership test is therefore still outstanding.
- Run `node --import tsx scripts/test-devnet-purchase.mts` to retry the opt-in live test when the faucet is available. It creates an ephemeral test wallet, requests only Devnet SOL, prepares a purchase, signs with that test wallet, verifies NFT ownership through the service and actual balance deduction, and checks duplicate submission does not charge twice. It never reads the user's Phantom keys. Test SOL left in the ephemeral wallet is not recoverable after the script exits.

Preparing or rejecting a signature does not spend SOL. The submitted transaction contains NFT creation and seller payment atomically. On successful confirmation the buyer pays the item price plus account creation costs and network fees. An on-chain failed transaction can still incur network fees. See [Solana transactions](https://solana.com/docs/core/transactions) and [fees](https://solana.com/docs/core/fees).

## Enforcement

`shared/src/solanaNetwork.ts` owns defaults, configuration validation and the Devnet genesis identity check. Invalid networks are rejected at Vite startup/build and backend startup. Custom RPC URLs must return the Devnet genesis hash; RPC failures stop execution.

The NFT service validates before preparing or returning a cached proposal, partially signing and submitting. The Anchor client validates before constructing transactions, signing and submitting. Both browser signing paths use `walletSafety.ts`, which checks the Devnet genesis identity, verifies the recent blockhash on Devnet, checks the payer, and rejects wallet or message changes during signing. The backend also checks signed messages against its stored proposal and verifies signatures. AI output cannot choose an RPC or bypass the execution service.

The extension has no Solana connection or signer. Existing Magic Eden research is read-only marketplace data, not a Mainnet RPC or execution path; its existing behavior is preserved.

## Phantom and test SOL

The current injected Phantom API does not expose a trustworthy selected-network getter. The UI does not claim to detect that setting. It shows the verified application network, instructions, and a user acknowledgment before requesting a purchase proposal. Actual transaction safety depends on RPC and blockhash validation, not the acknowledgment.

In Phantom, open Settings → Developer Settings → Testnet Mode and select Solana Devnet. See [Phantom instructions](https://help.phantom.com/articles/use-testnets-in-phantom-5997313271699). The existing [signTransaction flow](https://docs.phantom.com/solana/sending-a-transaction) signs only; GoBuy submits through its guarded RPC.

After connecting, click **Get 1 Devnet SOL**. This helper is shown and callable only in a Vite development build. It checks Devnet, requests a fixed airdrop, polls confirmation and refreshes the balance. Rate limits and uncertain confirmations produce a message instead of automatic repeated funding. Alternatively use https://faucet.solana.com with Devnet selected. **Refresh balance** checks Devnet again; unavailable balances never display as zero. Successful or failed confirmed purchases refresh the balance because both can incur fees.

## Historical simulation acceptance procedure

Use the current Tensor + Helius procedure above for marketplace transactions. The steps
below exercise the older simulation flow only.

1. Start both services; verify the DEVNET badge and Network: Solana Devnet.
2. Enable Devnet in Phantom, connect, and verify the shortened address and Devnet SOL balance. Check the Devnet acknowledgment.
3. Obtain test SOL using the helper; verify the balance increases after confirmation.
4. Ask `Mua tranh NFT dưới 1 SOL`. Na validates the request, chooses a gallery item and prepares a Devnet quote.
5. Review the price and fee estimate. Approve the signature in Phantom. GoBuy checks Devnet and the quote blockhash before opening the signature request, then checks again before submission.
6. Wait for confirmation. Verify the visible signature, updated balance, and transaction/NFT Explorer links with `cluster=devnet`.
7. If confirmation is uncertain, use the pending-order check. Do not create another purchase until it resolves. Reloading retains the pending order.
8. Change Phantom accounts/disconnect and verify the displayed wallet and balance clear. Reconnect before continuing.
9. Set `SOLANA_NETWORK=mainnet-beta` temporarily in either workspace and restart: startup must fail before any wallet approval. Restore Devnet. A custom RPC returning a foreign genesis must also fail closed.
10. Build with `npm run build` and preview the frontend: the airdrop helper must be absent. Mainnet execution remains disabled.

## Deployment findings and remaining manual checks

Inspection found `11111111111111111111111111111111` in both `anchor/Anchor.toml` and Rust `declare_id!`, the Devnet provider cluster, no frontend `.env.local` program ID, and no generated IDL in `frontend/public/idl` or `anchor/target/idl`. No program ID was changed and nothing was deployed. Thus this checkout cannot establish that the custom GoBuy Anchor program is deployed. Provide the actual deployed public ID and matching generated IDL before testing the mandate/authorization client. It already verifies executable status on Devnet and IDL address equality before use.

The active `/na` chat uses the existing Metaplex Core gallery service, not the custom Anchor mandate program. This distinction predates these changes; this work preserves both paths. A real Phantom approval, live faucet funding, on-chain gallery confirmation and the deployed custom Anchor flow still require manual verification. Automated mocked tests are not proof of live chain success.

## Changed files

- Shared: `shared/src/solanaNetwork.ts`, `shared/src/index.ts`, `shared/tests/solanaNetwork.test.ts`.
- Frontend: `frontend/vite.config.ts`, `frontend/.env.example`, `frontend/src/services/solana/network.ts`, `client.ts`, new `walletSafety.ts`, `frontend/src/features/na/NaWorkspacePage.tsx`, `chat.css`, `frontend/tests/walletSafety.test.ts`, `frontend/e2e/devnet.spec.ts`.
- Backend: `backend/.env.example`, `backend/src/config/env.ts`, `backend/src/services/nftDemo/NftDemoService.ts`.
- Integration/config/docs: `.env.example`, `anchor/tests/authorization.test.ts`, this document.

Existing unrelated working-tree edits were preserved. No real environment secrets were changed.

## Automated verification

Run `npm run lint`, `npm test`, `npm run build`, and `npx playwright test frontend/e2e/devnet.spec.ts`. The focused browser test mocks the RPC and wallet to verify the badge, balance, airdrop confirmation/refresh, and foreign-network rejection. The unit suite checks fail-closed settings and prevents signature requests on a foreign RPC or blockhash. Older browser suites target an earlier UI and are not the acceptance test for the current chat.

Verified in this checkout: 88 unit/API tests passed, all workspace builds passed, type checks passed, and the focused browser test passed in installed Chrome. The bundled Playwright browser was missing; on PowerShell use `$env:PLAYWRIGHT_CHANNEL='chrome'` before the browser command. The build reports a frontend bundle-size warning. No live Phantom signature or on-chain success is claimed.
