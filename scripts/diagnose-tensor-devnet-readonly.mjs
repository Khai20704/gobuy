// Run after building backend/shared/adapter:
// node --env-file=backend/.env scripts/diagnose-tensor-devnet-readonly.mjs
// Only RPC reads. No LLM, transaction construction/submission, listings, or configuration writes.
import { nftSearchIntentSchema } from '@gobuy/shared'
import { scanTensorDevnetListings, TensorAdapterError } from '@gobuy/tensor-adapter'
import { HeliusClient, HeliusError, heliusRpcUrl } from '../backend/dist/nft/helius/HeliusClient.js'
import { HeliusNFTProvider } from '../backend/dist/nft/helius/HeliusNFTProvider.js'
import { TensorDevnetNFTProvider } from '../backend/dist/services/acquisition/TensorDevnetNFTProvider.js'
import { DiscoveryEngine, acquisitionConfig } from '../backend/dist/services/acquisition/discovery.js'

const log = data => console.log(JSON.stringify(data))
const failure = error => error instanceof TensorAdapterError
  ? { category: error.category, operation: error.operation, httpStatus: error.httpStatus, rpcCode: error.rpcCode,
    timeoutSource: error.timeoutSource, diagnostics: error.diagnostics }
  : error instanceof HeliusError ? { category: error.code, httpStatus: error.httpStatus, timeoutSource: error.timeoutSource }
    : { category: 'UNCLASSIFIED_FAILURE' }

class DiagnosticClient extends HeliusClient {
  async call(method, params, signal) {
    const started = Date.now()
    try { return await super.call(method, params, signal) }
    catch (error) {
      log({ stage: 'helius_read_failed', operation: method, durationMs: Date.now() - started, ...failure(error) })
      throw error
    }
  }
}

let stage = 'configuration'
try {
  const rpcUrl = heliusRpcUrl()
  stage = 'intent_validation'
  const intent = nftSearchIntentSchema.parse({ assetType: 'NFT', semanticQuery: 'any NFT under 1 SOL',
    terms: ['nft'], maximumLamports: '1000000000', currency: 'SOL', intent: 'acquire_asset', parser: 'literal', broadSearch: true })
  stage = 'scan'
  const scan = await scanTensorDevnetListings(rpcUrl, 1_000_000_000n, 50, AbortSignal.timeout(30000))
  log({ stage: 'scan', scanned: scan.scanned, activeSolListings: scan.activeSolListings,
    metadataMissing: scan.metadataMissing, unsupportedStandards: scan.unsupportedStandards,
    listings: scan.listings.length, diagnostics: scan.diagnostics })
  const provider = new TensorDevnetNFTProvider(rpcUrl, undefined, undefined, new HeliusNFTProvider(new DiagnosticClient()))
  stage = 'discovery'
  const reply = await new DiscoveryEngine([provider], acquisitionConfig().NFT_PROVIDER_TIMEOUT_MS).search(intent)
  log({ stage: 'discovery', status: reply.status, sources: reply.sources, verifiedCandidates: reply.candidates.length })
  let unchanged = 0
  stage = 'refresh'
  for (const candidate of reply.candidates.slice(0, 3)) {
    const refreshed = await provider.refresh(candidate, AbortSignal.timeout(15000))
    if (refreshed && refreshed.mint === candidate.mint && refreshed.listing.seller === candidate.listing.seller
      && refreshed.listing.priceLamports === candidate.listing.priceLamports) unchanged++
  }
  log({ stage: 'read_only_result', refreshedUnchanged: unchanged, purchaseExecuted: false,
    transactionExecutabilityVerified: false })
  if (reply.status === 'DATA_UNAVAILABLE') process.exitCode = 1
} catch (error) {
  log({ stage: 'verification_blocked', failedStage: stage, ...failure(error), purchaseExecuted: false })
  process.exitCode = 1
}
