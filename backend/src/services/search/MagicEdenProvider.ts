import { z } from 'zod'
import type { CandidateItem, SearchIntent } from '@gobuy/shared'
import type { SearchProvider } from './SearchProvider.js'
import { fetchJson, plainText, safeImage, type Fetcher } from './http.js'
import { recordSourceEvidence } from '../verification/evidence.js'

const listingSchema = z.object({
  tokenMint: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/), price: z.number().finite().nonnegative(),
  seller: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/), collection: z.string().optional(), collectionAddress: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/).optional(), token: z.object({ name: z.string().optional(), image: z.string().optional() }).optional(),
})
export class MagicEdenProvider implements SearchProvider {
  readonly name = 'Magic Eden'
  readonly mode = 'real' as const
  constructor(private readonly enabled = false, private readonly apiKey?: string, private readonly fetcher: Fetcher = fetch) {}
  unavailable(intent: SearchIntent) {
    if (!this.enabled) return 'MAGIC_EDEN_ENABLED is false.'
    if (!intent.collectionSymbol) return 'Provide an exact Magic Eden collection symbol to search NFT listings.'
  }
  async search(intent: SearchIntent, signal: AbortSignal): Promise<CandidateItem[]> {
    if (!intent.collectionSymbol) return []
    const url = new URL(`https://api-mainnet.magiceden.dev/v2/collections/${encodeURIComponent(intent.collectionSymbol)}/listings`)
    url.searchParams.set('limit', '12'); url.searchParams.set('listingAggMode', 'false')
    const headers: Record<string, string> = { Accept: 'application/json' }
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`
    const rows = z.array(z.unknown()).max(100).parse(await fetchJson(url, { signal, headers }, this.fetcher))
    return rows.flatMap(row => {
      const parsed = listingSchema.safeParse(row)
      if (!parsed.success) return []
      const item = parsed.data
      if (item.collection && item.collection !== intent.collectionSymbol) return []
      return [recordSourceEvidence({
        id: `me:${item.tokenMint}`, title: plainText(item.token?.name ?? item.tokenMint), price: item.price,
        currency: 'SOL', imageUrl: safeImage(item.token?.image), productUrl: `https://magiceden.io/item-details/${item.tokenMint}`,
        source: this.name, domain: 'magiceden.io', mode: this.mode, kind: 'nft' as const,
        collectionSymbol: intent.collectionSymbol, stockStatus: 'IN_STOCK',
        nft: { mint: item.tokenMint, collectionAddress: item.collectionAddress, seller: item.seller, marketplace: 'Magic Eden', listingStatus: 'LISTED' },
        seller: item.seller ? { name: plainText(item.seller) } : undefined,
        fetchedAt: new Date().toISOString(), signals: {},
        // Read-only mainnet research. Listing presence proves neither authenticity nor seller trust.
      })]
    })
  }
}
