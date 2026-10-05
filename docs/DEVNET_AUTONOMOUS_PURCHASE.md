# Devnet autonomous spend demo

This flow transfers Devnet SOL through the existing `spend_from_mandate` instruction to the configured settlement recipient. It does not execute an atomic marketplace purchase and does not claim NFT ownership or create a portfolio position.

## Metadata diagnosis

Helius enrichment supplies optional asset metadata. The Tensor mapper already normalized the candidate's top-level description/attributes, but its nested `asset` retained missing fields. MongoDB's default `ignoreUndefined: false` serializes these undefined fields as null. A read-only check of the existing Tensor quote for owner `9dJL3iVoECg6yaAeCoF3wKBPbkJkQE1WEucKm2fZUcAE` confirmed all three nested fields were null.

The shared candidate schema now preprocesses null/undefined descriptions to `""` and attributes to `[]`. Collection address remains nullable/optional; no address is invented. Helius also normalizes explicit null descriptions/attributes. Malformed non-null metadata still fails validation. Execution uses a separate strict schema requiring mint, seller, listing ID, positive SOL price, verified asset custody, Tensor marketplace, LISTED status and Devnet. Public keys are decoded before execution.

## Execution and authority

1. Explicit buy/purchase/mua language classifies as `BUY`; search/recommend/show and negated purchase language stay `SEARCH`. Discovery itself never spends.
2. Numbered NFT requests preserve the exact NFT name. When no SOL ceiling is given, the authenticated wallet's on-chain remaining mandate budget supplies the ceiling (capped at the discovery parser's existing 10 SOL limit).
3. `NaWorkspacePage.acquire` calls `executeAutonomousPurchase` → `POST /api/acquisition/autonomous-spend` → `AcquisitionService.autonomousPurchase`.
4. The backend requires an account-bound, verified wallet association, a saved BUY discovery, valid metadata/critical fields, and a freshly reverified unchanged listing.
5. `AutonomousPurchaseService.execute` checks Devnet genesis, mandate owner/PDA, derived vault PDA, executor, configured settlement, active/closed/expiry/category/budget and vault balance. Amount equals the listing price.
6. A durable order is reserved before spending. `executeVaultSpend` builds the existing `spendFromMandateInstruction`, signs with `client.agent` server-side, broadcasts, confirms, then reads the program receipt and mandate.
7. The browser receives only public result data. No Phantom `signTransaction` call is present in this execution path. No failed execution falls back to a wallet signer.
8. `GET /api/acquisition/autonomous-spends/:id` reconciles from the confirmed receipt without signing or resubmitting. Persisted request identity and the program's deterministic spend receipt prevent duplicate spending for the same request.
9. The UI labels the result **Devnet autonomous spend demo**, displays selection/price/actual spend/PDAs/signature/Devnet Explorer/status/before-and-after totals, and refreshes NaVaultPanel from the backend. Demo results never claim NFT transfer.

Wallet association is separate authentication, not a spend approval. A dedicated UI action signs the existing account-bound message once. It is never invoked automatically by PURCHASE. A valid mandate plus a public owner address alone does not prove that the requesting GoBuy account controls that wallet.

## Live read-only verification

Owner: `9dJL3iVoECg6yaAeCoF3wKBPbkJkQE1WEucKm2fZUcAE`

- Mandate: `7gfmi99mSw52BDyCroKvYAXmVguLVKSGHqLBhFQacABB`
- Vault: `GfjKEqEPghVscwJ3piwGwQvbxtug7quUVZBpi1kQJZEC`
- Status when checked: ACTIVE, NFT category; executor and settlement match existing configuration.
- Authorized: 1 SOL; spent: 0 SOL; remaining: 1 SOL.
- Bodega Monke #5 price: 40,000,000 lamports (0.04 SOL).
- Mint: `76REGf6ukL6Soer1D6TkvAnf6bXejEiFhvaNa2RaT1er`
- Listing: `6fadBjikjQpzRHGcQJnvPHZ6wAyFZuR9tQntRT9rhJdn`
- Seller: `GAP7adkjSA7tA4T3GRjavr8jzCPsTtJuyHfxH95m2Hs3`
- Blocker: MongoDB has no verified GoBuy wallet association for this owner. No live spend was sent, no confirmation signature exists, and no on-chain spend/remaining changes are claimed.

After restarting the updated app, connect this wallet and use the separate wallet-association action. Then request PURCHASE again. The app rechecks the listing and current mandate before attempting execution; these recorded observations are not a durable quote.

## Files changed for this task

- Shared: `src/acquisition.ts`, `src/autonomousPurchase.ts`, `src/collectionQuery.ts`, `src/index.ts`.
- Backend: `src/app.ts`, `src/http/routes/acquisition.ts`, `src/nft/helius/HeliusNFTProvider.ts`, `src/services/acquisition/AcquisitionService.ts`, `AutonomousPurchaseService.ts`, `AutonomousSpendBlockedError.ts`, `TensorDevnetNFTProvider.ts`, `discovery.ts`, `src/services/mandate/autonomousSpend.ts`, `spendFailureDetail.ts`.
- Frontend: `src/features/na/NaWorkspacePage.tsx`, `autonomousPurchase.ts`, `components/NaVaultPanel.tsx`, `src/services/api/acquisition.ts`.
- Regression tests: `backend/tests/autonomousPurchase.test.ts`, `backend/tests/heliusMigration.test.ts`.
- Read-only diagnostics: `scripts/inspect-autonomous-mandate.mts`, `backend/scripts/inspect-purchase-readiness.mts`.

Anchor, NA_PROGRAM_ID, agent keypair and NA_SETTLEMENT_ADDRESS were not changed or redeployed. Existing spend instruction encoding and settlement mechanics remain intact; error reporting now preserves sanitized RPC/Anchor details.

## Validation

- Workspace TypeScript and test TypeScript checks: `npm run lint`.
- Full suite: 214/214 tests passed before the last two additional purchase cases.
- Final purchase suite: 9/9 passed, including the two additional cases.
- Tests cover nullable metadata and BSON persistence, SEARCH rejection, BUY routing, mandate policy failures, missing critical listing fields, changed listing identity, wrong network/executor/vault, explicit named NFT matching, wallet-account isolation, agent-only signing, confirmed receipt totals, replay protection, read-only reconciliation and Anchor rejection.
- The execution fixture runs the actual spend transaction builder and Ed25519 agent signature against mocked RPC. Its 1 SOL → 0.04 SOL spent → 0.96 SOL remaining result is a regression test, not a live Devnet transaction.
