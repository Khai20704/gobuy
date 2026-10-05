import { z } from 'zod'
import { nftCandidateSchema, walletAddressSchema, type NFTCandidate, type NFTSearchIntent } from '@gobuy/shared'
import type { NFTDiscoveryProvider } from './discovery.js'
import type { NFTProviderResult } from '../nft-intelligence/marketContracts.js'
import { fetchJson, safeImage, ProviderRequestError, type Fetcher } from '../search/http.js'

const collectionSchema = z.object({ collId: z.string().min(1), name: z.string().nullable(),
  slugDisplay: z.string().nullable(), tensorVerified: z.boolean(), hidden: z.boolean(), flagReason: z.string().nullable() })
const rowSchema = z.object({ mint: walletAddressSchema, name: z.string().nullable().optional(),
  imageUri: z.string().nullable().optional(), listing: z.object({
    price: z.union([z.string().regex(/^\d+$/), z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)]),
    seller: walletAddressSchema, currency: z.string().nullable().optional(),
  }) })
const SOL = 'So11111111111111111111111111111111111111112'

// Intentionally exposes only two GET data endpoints. No RPC, signer or transaction API.
export class TensorMainnetReadOnlyProvider implements NFTDiscoveryProvider {
  readonly name = 'tensor-mainnet-readonly'
  constructor(private readonly key = process.env.TENSOR_API_KEY?.trim(), private readonly fetcher: Fetcher = fetch) {}
  private get(path: '/collections/find_collection' | '/mint/collection', params: Record<string, string>, signal: AbortSignal) {
    if (!this.key) throw new ProviderRequestError(undefined, 'AUTH_REQUIRED')
    const url = new URL('https://api.mainnet.tensordev.io/api/v1' + path)
    url.search = new URLSearchParams(params).toString()
    return fetchJson(url, { method: 'GET', headers: { accept: 'application/json', 'x-tensor-api-key': this.key }, signal }, this.fetcher)
  }
  async search(intent: NFTSearchIntent, signal: AbortSignal): Promise<NFTProviderResult> {
    const query = intent.collectionAddress ?? intent.collectionQuery ?? intent.collectionSymbol
    if (!query || !['LOWEST_PRICE', 'HIGHEST_PRICE'].includes(intent.objective ?? '')) return { candidates: [] }
    let raw: unknown
    try { raw = await this.get('/collections/find_collection', { filter: query }, signal) }
    catch (error) {
      if (error instanceof ProviderRequestError && error.status === 404) return { candidates: [], status: 'COLLECTION_NOT_FOUND' }
      throw error
    }
    const parsed = collectionSchema.safeParse(raw)
    if (!parsed.success) throw new ProviderRequestError(undefined, 'SCHEMA_MISMATCH')
    const collection = parsed.data
    if (collection.hidden || collection.flagReason) return { candidates: [], warnings: ['Tensor Mainnet: collection bị ẩn hoặc gắn cờ; không đề xuất.'] }
    const response = await this.get('/mint/collection', { collId: collection.collId,
      sortBy: intent.objective === 'HIGHEST_PRICE' ? 'ListingPriceDesc' : 'ListingPriceAsc',
      limit: '50', onlyListings: 'true', includeCurrencies: SOL,
      ...(!intent.priceDiscoveryOnly ? { maxPrice: intent.maximumLamports } : {}),
    }, signal)
    const envelope = z.object({ mints: z.array(z.unknown()) }).safeParse(response)
    if (!envelope.success) throw new ProviderRequestError(undefined, 'SCHEMA_MISMATCH')
    const observedAt = new Date().toISOString()
    const candidates: NFTCandidate[] = []
    let rejected = 0
    for (const rawRow of envelope.data.mints) {
      const row = rowSchema.safeParse(rawRow)
      if (!row.success) { rejected++; continue }
      const nft = row.data
      if (nft.listing.currency && nft.listing.currency !== SOL) continue
      const price = BigInt(nft.listing.price)
      if (price <= 0n || price > BigInt(intent.maximumLamports)) continue
      candidates.push(nftCandidateSchema.parse({ id: this.name + ':' + nft.mint, provider: this.name,
        sourceNetwork: 'mainnet', mint: nft.mint, name: nft.name || nft.mint, description: '',
        image: safeImage(nft.imageUri ?? undefined) ?? null, collection: collection.name || query, attributes: [],
        purchaseEligibility: { allowed: false, reason: 'MAINNET_READ_ONLY', verificationKind: 'independent' },
        listing: { priceLamports: price.toString(), currency: 'SOL', seller: nft.listing.seller,
          url: 'https://www.tensor.trade/trade/' + encodeURIComponent(collection.slugDisplay || collection.collId), observedAt },
        reasons: ['Listing Mainnet từ API Tensor; chỉ tham khảo giá chào bán.'],
        warnings: ['MAINNET · Chỉ xem, không mua được. Giá không phải tổng chi giao dịch.',
          'Xác minh collection của Tensor không thay thế yêu cầu xác minh độc lập để mua.'] }))
    }
    if (!candidates.length && rejected) throw new ProviderRequestError(undefined, 'SCHEMA_MISMATCH')
    return { candidates, resolvedCollection: { name: collection.name || query, symbol: query, source: this.name, verified: collection.tensorVerified },
      coverage: { listingsChecked: envelope.data.mints.length, collectionsChecked: 1 },
      warnings: ['Tensor Mainnet: tra cứu tối đa 50 listing theo thứ tự giá do API trả về; không bao quát mọi marketplace.'],
      diagnostics: [{ provider: this.name, endpoint: '/mint/collection', network: 'mainnet', latencyMs: 0,
        receivedRows: envelope.data.mints.length, acceptedRows: candidates.length, schemaRejectedRows: rejected }] }
  }
  async refresh(_candidate: NFTCandidate, _signal: AbortSignal): Promise<undefined> { return undefined }
}
