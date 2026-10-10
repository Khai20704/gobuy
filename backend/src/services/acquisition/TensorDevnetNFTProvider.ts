import { nftCandidateSchema, type NFTCandidate, type NFTSearchIntent } from '@gobuy/shared'
import { fetchTensorDevnetListing, mapWithConcurrency, scanTensorDevnetListings, type TensorScanResult } from '@gobuy/tensor-adapter'
import type { NFTDiscoveryProvider } from './discovery.js'
import { acquisitionLog } from './discovery.js'
import { HeliusNFTProvider } from '../../nft/helius/HeliusNFTProvider.js'
import { HeliusError, heliusRpcUrl } from '../../nft/helius/HeliusClient.js'
import { NFTPurchaseError } from '../../nft/errors.js'
import { normalizeListing } from '../../nft/tensor/TensorMarketplaceClient.js'
import { safeImage } from '../search/http.js'

/**
 * Simultaneous per-listing ownership verifications.
 *
 * Each verification costs two Helius reads plus the metadata reads the scan already made. Running the
 * whole set sequentially is what pushed discovery to the edge of its provider deadline; four at a
 * time cuts wall-clock latency without tripping the endpoint's own concurrency limits.
 */
const VERIFY_CONCURRENCY = 4

type Listing = NonNullable<Awaited<ReturnType<typeof fetchTensorDevnetListing>>>

/** A per-listing rejection that says nothing about provider health. */
function isListingRejection(error: unknown) {
  return error instanceof NFTPurchaseError && error.code === 'LISTING_CHANGED'
    || error instanceof HeliusError && error.code === 'ASSET_NOT_FOUND'
}

/** An endpoint/transport fault: the listing is unknown, not proven absent. */
function isTransientProviderFailure(error: unknown) {
  return error instanceof HeliusError
    && (error.code === 'NETWORK_ERROR' || error.code === 'TIMEOUT' || error.code === 'RATE_LIMITED' || error.code === 'INVALID_RESPONSE')
}

export class TensorDevnetNFTProvider implements NFTDiscoveryProvider {
  readonly name = 'tensor'
  constructor(private readonly rpcUrl?: string,
    private readonly scan = scanTensorDevnetListings, private readonly read = fetchTensorDevnetListing,
    private readonly assets: Pick<HeliusNFTProvider, 'verifyOwner'> & Partial<Pick<HeliusNFTProvider, 'verifyNetwork'>> = new HeliusNFTProvider()) {}

  private async candidate(listing: Listing, signal: AbortSignal) {
    // Legacy Tensor listings hold the NFT in the ListState PDA's token account.
    // Seller remains the decoded ListState.owner; it is not the token custodian.
    const asset = await this.assets.verifyOwner(listing.mint, listing.listState, signal)
    return nftCandidateSchema.parse({ id: 'tensor:' + listing.mint, provider: this.name, sourceNetwork: 'devnet',
      mint: listing.mint, name: asset.name || listing.mint, description: asset.description ?? '', image: safeImage(asset.image) ?? null,
      collection: asset.collectionName ?? asset.collectionAddress ?? '', attributes: asset.attributes ?? [], asset,
      marketplaceListing: normalizeListing(listing),
      listing: { priceLamports: listing.priceLamports, currency: 'SOL', seller: listing.seller, url: '', observedAt: new Date().toISOString() },
      reasons: ['Tensor listing and Helius asset ownership verified on Devnet.'],
      warnings: ['Kiểm tra quyền giữ NFT trong Tensor không xác nhận giá trị đầu tư. Giao dịch mua Tensor trên Devnet vẫn cần chữ ký Phantom riêng; chưa có giao dịch nào được gửi.'] })
  }

  /**
   * Verifies every scanned listing and returns the candidates that passed.
   *
   * A single transient Helius failure must not silently become "no listings": if nothing could be
   * verified and at least one failure was a transport/endpoint fault, the error is rethrown so the
   * engine reports an unavailable market. When some listings verify, their successes are returned and
   * the failures are recorded, because a partial provider outage is not the same as an empty market.
   */
  private async verifyListings(listings: Listing[], maximumLamports: bigint, collectionAddress: string | undefined,
    signal: AbortSignal): Promise<NFTCandidate[]> {
    const outcomes = await mapWithConcurrency(listings, VERIFY_CONCURRENCY, async listing => {
      try {
        const candidate = await this.candidate(listing, signal)
        if (collectionAddress && candidate.asset?.collectionAddress !== collectionAddress) return undefined
        return candidate
      } catch (error) {
        return { failed: error }
      }
    })
    const candidates: NFTCandidate[] = []
    let rejected = 0
    const failures: unknown[] = []
    for (const outcome of outcomes) {
      if (!outcome) { rejected++; continue }
      if ('failed' in (outcome as { failed?: unknown })) { failures.push((outcome as { failed: unknown }).failed); continue }
      if (BigInt((outcome as NFTCandidate).listing.priceLamports) <= 0n
        || BigInt((outcome as NFTCandidate).listing.priceLamports) > maximumLamports) { rejected++; continue }
      candidates.push(outcome as NFTCandidate)
    }
    const fatal = failures.find(error => !isListingRejection(error) && !isTransientProviderFailure(error))
    if (fatal) throw fatal
    const transient = failures.filter(isTransientProviderFailure)
    if (!candidates.length && transient.length) throw transient[0]
    acquisitionLog('tensor_verification', { provider: this.name, received: listings.length, accepted: candidates.length,
      budgetRejected: rejected, schemaRejected: failures.length - transient.length - failures.filter(isListingRejection).length,
      finalCandidates: candidates.length })
    return candidates
  }

  async search(request: NFTSearchIntent, signal: AbortSignal): Promise<NFTCandidate[]> {
    await this.assets.verifyNetwork?.(signal)
    const result: TensorScanResult = await this.scan(this.rpcUrl ?? heliusRpcUrl(), BigInt(request.maximumLamports), 50, signal)
    // Per-phase timings make the failing RPC step identifiable without ever logging the endpoint URL,
    // a credential or a response body. Every field below is a constant or a number.
    for (const step of result.diagnostics ?? []) acquisitionLog('tensor_scan', { provider: this.name, network: 'devnet',
      operation: step.operation, latencyMs: step.durationMs, accountsRead: step.accountsRead,
      ...(step.category ? { category: step.category } : {}),
      ...(step.httpStatus !== undefined ? { httpStatus: step.httpStatus } : {}),
      ...(step.timeoutSource ? { timeoutSource: step.timeoutSource } : {}) })
    acquisitionLog('tensor_scan_summary', { provider: this.name, network: 'devnet', received: result.scanned,
      accepted: result.activeSolListings, schemaRejected: result.metadataMissing,
      budgetRejected: result.unsupportedStandards, finalCandidates: result.listings.length })
    const listings = result.listings
      .filter(listing => BigInt(listing.priceLamports) > 0n && BigInt(listing.priceLamports) <= BigInt(request.maximumLamports))
    return this.verifyListings(listings, BigInt(request.maximumLamports), request.collectionAddress, signal)
  }

  async refresh(candidate: NFTCandidate, signal: AbortSignal): Promise<NFTCandidate | undefined> {
    if (candidate.provider !== this.name || !candidate.mint) return undefined
    const listing = await this.read(this.rpcUrl ?? heliusRpcUrl(), candidate.mint, signal)
    return listing ? this.candidate(listing, signal) : undefined
  }
}
