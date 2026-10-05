import { z } from 'zod'
import { isPublicHttpsUrl, type CandidateItem, type SearchIntent } from '@gobuy/shared'
import type { SearchProvider } from './SearchProvider.js'
import { fetchJson, plainText, safeImage, type Fetcher } from './http.js'
import { recordSourceEvidence } from '../verification/evidence.js'

const decimal = z.string().regex(/^\d+(?:\.\d+)?$/).transform(Number).pipe(z.number().finite().nonnegative())
const amount = z.object({ value: decimal, currency: z.string().regex(/^[A-Z]{3}$/) })
const region = z.object({ regionType: z.string(), regionId: z.string().optional() })
const itemSchema = z.object({
  itemId: z.string().max(180), title: z.string(), itemWebUrl: z.string(), condition: z.string().optional(),
  price: amount.optional(),
  image: z.object({ imageUrl: z.string().optional() }).optional(),
  seller: z.object({ username: z.string().optional(), feedbackPercentage: decimal.pipe(z.number().max(100)).optional(),
    feedbackScore: z.number().int().optional() }).optional(),
})
const detailSchema = itemSchema.extend({
  brand: z.string().optional(), itemEndDate: z.iso.datetime().optional(),
  localizedAspects: z.array(z.object({ name: z.string(), value: z.string() })).max(200).optional(),
  estimatedAvailabilities: z.array(z.object({ estimatedAvailabilityStatus: z.string().optional() })).max(20).optional(),
  primaryProductReviewRating: z.object({ averageRating: decimal.pipe(z.number().max(5)).optional(), reviewCount: z.number().int().nonnegative().optional() }).optional(),
  returnTerms: z.object({ returnsAccepted: z.boolean().optional(), returnInstructions: z.string().optional() }).optional(),
  shippingOptions: z.array(z.object({ shippingCost: amount.optional(),
    shipToLocationUsedForEstimate: z.object({ country: z.string() }).optional() })).max(50).optional(),
  shipToLocations: z.object({ regionIncluded: z.array(region).optional(), regionExcluded: z.array(region).optional() }).optional(),
})
export class EbayProvider implements SearchProvider {
  readonly name = 'eBay'
  readonly mode = 'real' as const
  constructor(private readonly token?: string, private readonly marketplace = 'EBAY_US', private readonly fetcher: Fetcher = fetch) {}
  unavailable(intent: SearchIntent) {
    if (!this.token) return 'EBAY_ACCESS_TOKEN is not configured.'
    if (intent.collectionSymbol || /\bnft\b/i.test(intent.category ?? '')) return 'Physical-product provider skipped for NFT search.'
  }
  async search(intent: SearchIntent, signal: AbortSignal): Promise<CandidateItem[]> {
    const url = new URL('https://api.ebay.com/buy/browse/v1/item_summary/search')
    url.searchParams.set('q', [intent.product, ...intent.keywords, intent.brand, intent.model].filter(Boolean).join(' ').slice(0, 100))
    url.searchParams.set('limit', '12')
    url.searchParams.set('filter', 'buyingOptions:{FIXED_PRICE}')
    const headers = { Authorization: `Bearer ${this.token}`, 'X-EBAY-C-MARKETPLACE-ID': this.marketplace, Accept: 'application/json' }
    const body = z.object({ itemSummaries: z.array(z.unknown()).max(200).optional() }).parse(await fetchJson(url, {
      signal, headers,
    }, this.fetcher))
    const results = await Promise.all((body.itemSummaries ?? []).slice(0, 12).map(async row => {
      const parsed = itemSchema.safeParse(row)
      if (!parsed.success || !isPublicHttpsUrl(parsed.data.itemWebUrl)) return []
      let item = parsed.data
      let detail: z.infer<typeof detailSchema> | undefined
      try {
        const response = detailSchema.parse(await fetchJson(`https://api.ebay.com/buy/browse/v1/item/${encodeURIComponent(item.itemId)}`, {
          signal: AbortSignal.any([signal, AbortSignal.timeout(2500)]), headers,
        }, this.fetcher))
        if (response.itemId === item.itemId && isPublicHttpsUrl(response.itemWebUrl)) { detail = response; item = response }
      } catch { /* Retain retrieved summary facts; absent details stay UNKNOWN. */ }
      const aspect = (name: string) => detail?.localizedAspects?.find(value => value.name.toLowerCase() === name)?.value
      const statuses = detail?.estimatedAvailabilities?.map(value => value.estimatedAvailabilityStatus) ?? []
      const stockStatus = detail?.itemEndDate && Date.parse(detail.itemEndDate) <= Date.now() ? 'OUT_OF_STOCK'
        : statuses.length === 1 && ['IN_STOCK', 'LIMITED_STOCK', 'OUT_OF_STOCK'].includes(statuses[0] ?? '') ? statuses[0] as CandidateItem['stockStatus'] : undefined
      const shipping = intent.preferences.shippingCountry ? detail?.shippingOptions?.filter(option => option.shippingCost?.currency === item.price?.currency
        && option.shipToLocationUsedForEstimate?.country === intent.preferences.shippingCountry).sort((a, b) => a.shippingCost!.value - b.shippingCost!.value)[0] : undefined
      const regions = detail?.shipToLocations
      const countries = (values?: z.infer<typeof region>[]) => values?.filter(value => value.regionType === 'COUNTRY' && /^[A-Z]{2}$/.test(value.regionId ?? '')).map(value => value.regionId!)
      // Broad regions and sub-country exclusions require geographic resolution; do not guess.
      const shippingCountries = regions?.regionExcluded?.some(value => value.regionType !== 'COUNTRY') ? undefined : countries(regions?.regionIncluded)
      return [recordSourceEvidence({
        id: `ebay:${item.itemId}`, title: plainText(item.title), productUrl: item.itemWebUrl,
        price: item.price?.value, currency: item.price?.currency, imageUrl: safeImage(item.image?.imageUrl),
        condition: item.condition && plainText(item.condition), source: this.name, mode: this.mode, kind: 'product' as const,
        domain: new URL(item.itemWebUrl).hostname, fetchedAt: new Date().toISOString(),
        brand: detail?.brand && plainText(detail.brand), model: aspect('model') && plainText(aspect('model')!), size: aspect('size') && plainText(aspect('size')!),
        stockStatus, productRating: detail?.primaryProductReviewRating?.averageRating, productReviewCount: detail?.primaryProductReviewRating?.reviewCount,
        costs: shipping?.shippingCost ? { shipping: shipping.shippingCost.value, currency: shipping.shippingCost.currency, shippingCountry: intent.preferences.shippingCountry } : undefined,
        signals: { returnsAccepted: detail?.returnTerms?.returnsAccepted,
          returnPolicy: detail?.returnTerms?.returnInstructions && plainText(detail.returnTerms.returnInstructions, 500),
          shippingCountries, excludedShippingCountries: countries(regions?.regionExcluded) },
        seller: item.seller ? { name: item.seller.username && plainText(item.seller.username),
          rating: item.seller.feedbackPercentage, ratingScale: 'percent' as const, feedbackScore: item.seller.feedbackScore } : undefined,
        // eBay feedbackScore is a net score, NOT a review count or verified-seller flag.
        // estimatedSoldQuantity is not an exact purchase count; omitted instead of guessed.
        // Missing tax/fee data never becomes zero. A shipping quote is not a checkout total.
      })]
    }))
    return results.flat()
  }
}
