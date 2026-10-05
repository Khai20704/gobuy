# Tensor + Helius Devnet migration report

Updated 2026-10-04. Implementation is a real Tensor Devnet purchase preparation/submission path with Phantom signing. Autonomous purchasing is NOT implemented or claimed.

## Runtime and removal audit
Previously: chat -> NFTIntentParser -> MagicEdenNFTProvider -> collection resolution/listings/stats/activity REST -> ranking -> simulated NFT or optional Tensor purchase.
Now: chat -> NFTIntentParser -> TensorDevnetNFTProvider -> official Tensor program account discovery -> hard lamport budget -> Helius DAS and current token-account ownership -> deterministic ranking -> signed application spending policy -> TensorMarketplaceClient purchase plan -> Phantom -> trusted Devnet RPC -> confirmed transaction and token ownership.

Deleted obsolete acquisition files:
- backend/src/services/acquisition/MagicEdenNFTProvider.ts
- backend/src/services/acquisition/magicEdenHttp.ts
- backend/src/services/nft-intelligence/NFTCollectionResolver.ts
- backend/src/services/nft-intelligence/NFTMarketProvider.ts (unused duplicate interface)

Retained backend/src/services/search/MagicEdenProvider.ts only for the separately configured read-only /api/research endpoint. Its optional MAGIC_EDEN_ENABLED and MAGIC_EDEN_API_KEY configuration, createResearchService wiring, and research tests remain isolated. No acquisition factory imports it. Historical research documentation references describe that separate feature. The acquisition-specific provider tests were removed with the deleted implementation; generic intent, ranking, outage, policy and conversation tests remain.

Removed MAGIC_EDEN_* entries, TENSOR_ENABLED and NFT_COLLECTION_PAGES from the active backend .env and environment examples. Existing nonempty HELIUS_API_KEY was preserved, never printed. Added HELIUS_API_KEY, HELIUS_NETWORK=devnet, NFT_MARKETPLACE_PROVIDER=tensor, NFT_ASSET_PROVIDER=helius, DEMO_MODE=true; execution and discovery are devnet. Frontend does not receive the Helius credential.

## Helius implementation
backend/src/nft/helius/HeliusClient.ts uses backend-only https://devnet.helius-rpc.com/ with an encoded api-key query parameter. It implements call<T>(method, params, signal), a bounded timeout, HTTP/JSON-RPC validation, redirect refusal, sanitized errors without transport causes, and genesis verification.
Failure codes: AUTH_FAILED, RATE_LIMITED, TIMEOUT, NETWORK_ERROR, INVALID_RESPONSE, ASSET_NOT_FOUND.

HeliusNFTProvider uses getAsset for metadata/collection/attributes, getGenesisHash for network identity and getTokenAccountsByOwner with jsonParsed/confirmed for current ownership. Missing metadata stays absent. Only uncompressed classic/programmable NFTs with single ownership and not burnt are accepted. DAS indexed ownership and current token ownership must match the Tensor seller.
Helius supplies no listing prices or marketplace history.

Official references:
- https://www.helius.dev/docs/api-reference/endpoints
- https://www.helius.dev/docs/api-reference/das/getasset

## Tensor integration
Existing isolated workspace @gobuy/tensor-adapter uses @tensor-foundation/marketplace 1.0.0 and @solana/web3.js 2.0.0; backend keeps its web3.js v1 bridge.
Program: TCMPhJdwDryooaGtiocG1u3xcYbRpiJzb283XfCZsDp, imported from TENSOR_MARKETPLACE_PROGRAM_ADDRESS in the official client, not duplicated in runtime code.
Source: https://github.com/tensor-foundation/marketplace

Discovery calls getProgramAccounts with the official ListState discriminator, decodeListState, official metadata/PDA resolvers and mint owner validation. It filters expired/private/cosigned/non-SOL/unsupported-standard orders. Prices use the SDK bigint amount converted to a decimal lamport string; budget comparisons use BigInt. Scans return at most 50 eligible supported listings; this is bounded coverage, not the whole market.

TensorMarketplaceClient implements searchListings, refreshListing and buildPurchase. Listing IDs are actual ListState addresses; persisted IDs can be reread without a process-local cache. Build checks current listing ID, mint, seller and exact price before getBuyLegacyInstructionAsync. It returns explicit marketplace/network/listing/price/instructions. Purchase preparation and submission reverify Helius ownership. Changed listing/price and missing listings cannot submit. The on-chain buy maximum also bounds price if state changes after the last read.

## Intent and ranking
BUY defaults to BEST_OVERALL; SEARCH only discovers/ranks. Vietnamese accented worth-buying wording retains BUY; the existing dang/đáng regression suite remains. “tranh” now produces deterministic art/painting/illustration metadata terms. Subject matching uses actual name, description, collection address/name and attributes; no LLM art classification.

Tensor BEST_OVERALL weights: metadata relevance .30, budget price fit .30, independently supplied rarity .20, ownership verification .10, listing creation freshness .10. Unavailable factors are excluded and remaining weights normalized. Observed-at timestamps are NOT claimed as listing creation time. Trait count is NOT rarity. Price fit = clamp(1 - price / maximumBudget). Ranking is deterministic; score describes available evidence, not investment safety.
LOWEST_PRICE uses price fit explicitly; RARITY without rarity data is insufficient. MOST_BOUGHT, STRONGEST_MOMENTUM, TRENDING and BEST_LIQUIDITY do not acquire fabricated volume/floor/buyer/sales history. Generic legacy research models remain available for their separate research use; Tensor never fills them with invented data.
Existing strict “under” budgets remain one lamport below the boundary; maxPriceSol records the user's stated amount.

## Policy, signing, revocation and confirmation
Tensor preparation requires a backend spending policy signed by the wallet. Frontend passes the activated NFT policy ID to /quote and clears it when revoked. Backend checks owner, network, category, expiry, revocation and reservation; SpendingPolicyService checks per-transaction/daily/total limits and allowed mint. The reservation conservatively covers the user maximum, including fees, rather than just the listing price. Submission rechecks policy and listing state.

An earlier application-level rule blocked every Tensor Devnet mint that lacked a fresh independent identity attestation. That rule was removed at the user's request: `backend/src/nft/IndependentVerification.ts` and its prepare/submit call sites are deleted, the devnet candidates no longer carry a `VERIFICATION_UNAVAILABLE` purchase-eligibility flag, and `/api/acquisition/config` no longer advertises `requireIndependentVerification`. A confirmed purchase still means only that the on-chain listing settled: Helius listing and current token-ownership checks, Devnet genesis verification, the signed spending policy, the budget bound and explicit Phantom signing all still apply, and none of them is a claim about token reputation, collection legitimacy or investment value.

Policy is APPLICATION LEVEL. Anchor currently stores mandates and authorization records; it has no funded SOL vault, Tensor CPI, spend counters tied to purchases, or delegated executor authority. Its program ID remains an undeployed sentinel. Signing a policy message does not delegate Phantom transaction signing. /config reports autonomousSigning=false. Every real purchase requires a new Phantom transaction signature. No wallet secret/seed is stored.

Next on-chain architecture is specified in DELEGATED_TENSOR_EXECUTION.md. It is not a deployed or tested vault. Exact blocker: implement and deploy the policy-enforcing funded vault/Tensor CPI, obtain its executor setup and a user's one-time authorization/funding. Application checks alone cannot provide atomic on-chain revocation.

Execution uses the existing trusted Devnet RPC from solanaConfig; Tensor discovery/asset data use Helius. Genesis is checked on reads and before sendRawTransaction, with preflight enabled. The unsigned quote is simulated, total debit plus network fee must fit budget/balance, signed message must match the stored quote, and replay is reconciled rather than resubmitted. getTransaction at confirmed commitment must have no meta.err; current buyer token ownership is checked before CONFIRMED. The existing frontend receipt contract uses CONFIRMED (not PURCHASED) and contains signature/asset/totalLamports. Constructing a quote never means purchase success.

## Live proof and current user-visible blocker
Live checks on 2026-10-04:
- Configured Helius endpoint returned HTTP 401 / AUTH_FAILED. A credential exists, but the endpoint rejects it. No successful Helius asset verification is claimed.
- Independent public Devnet diagnostic successfully scanned the actual Tensor program: 520 ListState accounts, 189 active SOL listings under the diagnostic budget, 180 missing metadata and 1 unsupported standard. These are scan observations, not volume/liquidity metrics.
- Example: Bodega Monke #5, mint 76REGf6ukL6Soer1D6TkvAnf6bXejEiFhvaNa2RaT1er, listing 6fadBjikjQpzRHGcQJnvPHZ6wAyFZuR9tQntRT9rhJdn, seller GAP7adkjSA7tA4T3GRjavr8jzCPsTtJuyHfxH95m2Hs3, 40000000 lamports (0.04 SOL).
- No purchase submitted and no transaction signature claimed.
- Public RPC diagnostic is explicit and read-only, not a runtime fallback bypassing Helius verification.
- Ocean-themed availability remains unknown until valid Helius metadata is available.

Fix current search outage: replace/validate HELIUS_API_KEY in backend/.env using Helius Dashboard, restart backend, then run from repository root:
    node --env-file=backend/.env scripts/check-nft-devnet.mjs
The script prints only safe status codes and public account data. Discovery now reports the Helius authentication failure instead of a generic Tensor outage. LLM fallback does not remove the explicit budget or prevent literal search.

## Files and validation
Created: backend/src/nft/helius/{HeliusClient,HeliusNFTProvider}.ts; backend/src/nft/tensor/TensorMarketplaceClient.ts; backend/src/nft/errors.ts; backend/tests/heliusMigration.test.ts; scripts/check-nft-devnet.mjs; docs/DELEGATED_TENSOR_EXECUTION.md.
Modified: acquisition provider factory, Tensor provider/executor, discovery/parser, intent aliases, acquisition ranker/service, acquisition HTTP configuration, API typed errors, shared candidate/network contracts, tensor adapter, frontend NFT policy wiring, active env/examples, migration docs, acquisition/tensor/chat regression tests.
Deleted files are listed above; unrelated pre-existing working-tree changes were preserved.

Tests cover Helius asset validation/missing/owner mismatch/invalid payload/auth/rate/network/timeout/Devnet, Tensor listing discovery/refresh/change/disappearance/build/network, Vietnamese BUY/SEARCH, missing rarity, metadata-vs-price ranking, Helius outage/auth diagnosis and spending policy limits/revocation/expiry.
Final test/lint/build results are recorded in MIGRATION_VALIDATION.md.

Remaining limitations: Helius 401 blocks live metadata discovery; no autonomous signer/vault; Phantom signing required; unsupported NFT standards and missing metadata are omitted; bounded discovery does not guarantee a matching theme; no investment analytics; no live end-to-end purchase proof.
