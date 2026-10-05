import { NFTPurchaseError } from '../errors.js'
import { buildTensorLegacyBuyInstruction, fetchTensorDevnetListing, fetchTensorDevnetListingById, scanTensorDevnetListings,
  type TensorListing, type TensorBuyInstruction } from '@gobuy/tensor-adapter'
import type { NFTSearchIntent } from '@gobuy/shared'
import { heliusRpcUrl } from '../helius/HeliusClient.js'

export type NFTMarketplaceListing = { listingId: string; mint: string; seller: string; priceLamports: string;
  currency: 'SOL'; marketplace: 'Tensor'; network: 'devnet'; status: 'LISTED' | 'SOLD' | 'CANCELLED' | 'INVALID'; listedAt?: string }
export type NFTMarketplaceResult = { status: 'SUCCESS' | 'PARTIAL_DATA' | 'NO_MATCH' | 'DATA_UNAVAILABLE';
  listings: NFTMarketplaceListing[]; diagnostics: { provider: 'Tensor'; network: 'devnet'; listingsChecked: number; validListings: number } }
export type MarketplacePurchasePlan = { marketplace: 'Tensor'; network: 'devnet'; listingId: string; mint: string;
  seller: string; priceLamports: string; instructions: TensorBuyInstruction[]; expiresAtSlot?: number }
export interface NFTMarketplaceProvider {
  searchListings(intent: NFTSearchIntent, signal: AbortSignal): Promise<NFTMarketplaceResult>
  refreshListing(listingId: string, signal: AbortSignal): Promise<NFTMarketplaceListing | null>
  buildPurchase(listing: NFTMarketplaceListing, buyer: string, signal: AbortSignal): Promise<MarketplacePurchasePlan>
}
export const normalizeListing = (listing: TensorListing): NFTMarketplaceListing => ({ listingId: listing.listState,
  mint: listing.mint, seller: listing.seller, priceLamports: listing.priceLamports, currency: 'SOL', marketplace: 'Tensor',
  network: 'devnet', status: 'LISTED' })
export class TensorMarketplaceClient implements NFTMarketplaceProvider {
  private readonly mints = new Map<string, string>()
  constructor(private readonly rpcUrl = heliusRpcUrl(), private readonly scan = scanTensorDevnetListings,
    private readonly read = fetchTensorDevnetListing, private readonly build = buildTensorLegacyBuyInstruction) {}
  async searchListings(intent: NFTSearchIntent, signal: AbortSignal): Promise<NFTMarketplaceResult> {
    const result = await this.scan(this.rpcUrl, BigInt(intent.maximumLamports), 50, signal)
    const listings = result.listings.filter(row => BigInt(row.priceLamports) > 0n && BigInt(row.priceLamports) <= BigInt(intent.maximumLamports)).map(normalizeListing)
    for (const listing of listings) this.mints.set(listing.listingId, listing.mint)
    return { status: !listings.length ? 'NO_MATCH' : result.metadataMissing || result.unsupportedStandards ? 'PARTIAL_DATA' : 'SUCCESS', listings,
      diagnostics: { provider: 'Tensor', network: 'devnet', listingsChecked: result.scanned, validListings: listings.length } }
  }
  async refreshListing(listingId: string, signal: AbortSignal) {
    const mint = this.mints.get(listingId)
    const listing = mint ? await this.read(this.rpcUrl, mint, signal) : await fetchTensorDevnetListingById(this.rpcUrl, listingId, signal)
    return listing?.listState === listingId ? normalizeListing(listing) : null
  }
  async buildPurchase(listing: NFTMarketplaceListing, buyer: string, signal: AbortSignal): Promise<MarketplacePurchasePlan> {
    if (listing.network !== 'devnet' || listing.marketplace !== 'Tensor') throw new NFTPurchaseError('NETWORK_MISMATCH')
    const current = await this.read(this.rpcUrl, listing.mint, signal)
    if (!current) throw new NFTPurchaseError('LISTING_UNAVAILABLE')
    if (current.listState !== listing.listingId || current.mint !== listing.mint || current.seller !== listing.seller) throw new NFTPurchaseError('LISTING_CHANGED')
    if (current.priceLamports !== listing.priceLamports) throw new NFTPurchaseError('PRICE_CHANGED')
    const instruction = await this.build(this.rpcUrl, listing.mint, buyer, BigInt(listing.priceLamports), signal)
    if (instruction.listState !== listing.listingId || instruction.mint !== listing.mint || instruction.seller !== listing.seller) throw new NFTPurchaseError('LISTING_CHANGED')
    if (instruction.priceLamports !== listing.priceLamports) throw new NFTPurchaseError('PRICE_CHANGED')
    return { marketplace: 'Tensor', network: 'devnet', listingId: listing.listingId, mint: listing.mint,
      seller: listing.seller, priceLamports: listing.priceLamports, instructions: [instruction] }
  }
}
