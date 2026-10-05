import { nftCandidateSchema, type NFTCandidate, type NFTSearchIntent } from '@gobuy/shared'
import { fetchTensorDevnetListing, scanTensorDevnetListings } from '@gobuy/tensor-adapter'
import type { NFTDiscoveryProvider } from './discovery.js'
import { HeliusNFTProvider } from '../../nft/helius/HeliusNFTProvider.js'
import { HeliusError, heliusRpcUrl } from '../../nft/helius/HeliusClient.js'
import { normalizeListing } from '../../nft/tensor/TensorMarketplaceClient.js'
import { safeImage } from '../search/http.js'

export class TensorDevnetNFTProvider implements NFTDiscoveryProvider {
  readonly name = 'tensor'
  constructor(private readonly rpcUrl?: string,
    private readonly scan = scanTensorDevnetListings, private readonly read = fetchTensorDevnetListing,
    private readonly assets: Pick<HeliusNFTProvider, 'verifyOwner'> & Partial<Pick<HeliusNFTProvider, 'verifyNetwork'>> = new HeliusNFTProvider()) {}
  private async candidate(listing: NonNullable<Awaited<ReturnType<typeof fetchTensorDevnetListing>>>, signal: AbortSignal) {
    // Legacy Tensor listings hold the NFT in the ListState PDA's token account.
    // Seller remains the decoded ListState.owner; it is not the token custodian.
    const asset = await this.assets.verifyOwner(listing.mint, listing.listState, signal)
    return nftCandidateSchema.parse({ id: 'tensor:' + listing.mint, provider: this.name, sourceNetwork: 'devnet',
      mint: listing.mint, name: asset.name || listing.mint, description: asset.description ?? '', image: safeImage(asset.image) ?? null,
      collection: asset.collectionName ?? asset.collectionAddress ?? '', attributes: asset.attributes ?? [], asset,
      marketplaceListing: normalizeListing(listing),
      listing: { priceLamports: listing.priceLamports, currency: 'SOL', seller: listing.seller, url: '', observedAt: new Date().toISOString() },
      reasons: ['Tensor listing and Helius asset ownership verified on Devnet.'],
      warnings: ['Kiểm tra quyền giữ NFT trong Tensor không xác nhận giá trị đầu tư. Devnet autonomous spend demo chỉ chứng minh chi tiêu từ mandate; chưa mua hoặc chuyển NFT.'] })
  }
  async search(request: NFTSearchIntent, signal: AbortSignal): Promise<NFTCandidate[]> {
    await this.assets.verifyNetwork?.(signal)
    const result = await this.scan(this.rpcUrl ?? heliusRpcUrl(), BigInt(request.maximumLamports), 50, signal)
    const candidates: NFTCandidate[] = []
    for (const listing of result.listings) {
      if (BigInt(listing.priceLamports) <= 0n || BigInt(listing.priceLamports) > BigInt(request.maximumLamports)) continue
      try {
        const candidate = await this.candidate(listing, signal)
        if (!request.collectionAddress || candidate.asset?.collectionAddress === request.collectionAddress) candidates.push(candidate)
      } catch (error) {
        if (error instanceof HeliusError && error.code === 'ASSET_NOT_FOUND' || error instanceof Error && error.message === 'LISTING_CHANGED') continue
        throw error
      }
    }
    return candidates
  }
  async refresh(candidate: NFTCandidate, signal: AbortSignal): Promise<NFTCandidate | undefined> {
    if (candidate.provider !== this.name || !candidate.mint) return undefined
    const listing = await this.read(this.rpcUrl ?? heliusRpcUrl(), candidate.mint, signal)
    return listing ? this.candidate(listing, signal) : undefined
  }
}
