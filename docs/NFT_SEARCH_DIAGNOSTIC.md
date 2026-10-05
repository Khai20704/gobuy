# NFT search follow-up — 2026-10-04

The replacement Helius key successfully returned HTTP 200 and the Devnet genesis hash. The previous HTTP 401 diagnosis no longer applies to this key.

Live scan returned eight supported Tensor listings under 1 SOL. All eight were rejected by the old custody check because it compared NFT token owner with the seller. Tensor Legacy listings transfer the NFT into a token account controlled by the canonical ListState PDA; the seller is stored separately in ListState.owner.

Fixed discovery, ranking and pre-purchase checks to verify the decoded listing PDA's custody while preserving seller validation against the on-chain listing. No seller field or asset ownership is fabricated. Reference: https://github.com/tensor-foundation/marketplace/blob/main/program/src/instructions/legacy/list.rs

Added one retry for transient Helius transport/server failures on explicitly listed read methods. Authentication failures, rate limits and transaction writes are not retried. Increased the default discovery timeout from 15 to 30 seconds: measured full verification took 11.6–13.4 seconds, leaving too little room for network variation under the old limit.

Live result after custody fix:
- Helius asset and current token-account verification: all eight supported listings passed.
- `Find me an ocean-themed NFT under 1 SOL.`: `NO_MATCH`, provider `AVAILABLE`, eight verified candidates before subject filtering, zero matching ocean metadata.
- `Find any NFT under 1 SOL`: `MATCHED`, Bodega Monke #5, 40000000 lamports, mint `76REGf6ukL6Soer1D6TkvAnf6bXejEiFhvaNa2RaT1er`.
- No purchase transaction submitted.

Validation: 14 targeted Helius/Tensor tests passed, test-project typecheck passed, backend build passed.

Restart the backend to reload the environment and built code, then submit a new request. Existing chat messages are historical and will not change automatically. The AI fallback warning concerns the separate LLM provider; literal NFT search succeeded without it.

Read-only reproduction: `node --env-file=backend/.env scripts/diagnose-nft-search.mjs`. This prints public metadata and sanitized statuses, never the Helius key.
