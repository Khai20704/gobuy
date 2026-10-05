import { createHash } from 'node:crypto'
import { z } from 'zod'
import { isPublicHttpsUrl, type CandidateItem, type SearchIntent } from '@gobuy/shared'
import type { SearchProvider } from './SearchProvider.js'
import { fetchJson, plainText, safeImage, type Fetcher } from './http.js'
import { recordSourceEvidence } from '../verification/evidence.js'
import { enrichProductPage, fetchPublicHtml, type PageReader } from './productPage.js'

const resultSchema = z.object({ title: z.string(), url: z.string(), description: z.string().nullish(),
  thumbnail: z.object({ src: z.string().optional() }).nullish() })
const responseSchema = z.object({ web: z.object({ results: z.array(z.unknown()).max(100).optional() }).optional() })
export function webQuery(intent: SearchIntent) {
  return [intent.product, ...intent.keywords, intent.brand, intent.model,
    intent.preferences.authentic ? 'official retailer' : 'buy',
    intent.preferences.condition, intent.maxPrice === undefined ? '' : `under ${intent.maxPrice} ${intent.currency ?? ''}`,
    intent.preferences.shippingCountry].filter(Boolean).join(' ').slice(0, 400)
}
export class WebSearchProvider implements SearchProvider {
  readonly name = 'Brave Web Search'
  readonly mode = 'real' as const
  constructor(private readonly apiKey?: string, private readonly fetcher: Fetcher = fetch, private readonly readPage: PageReader = fetchPublicHtml) {}
  unavailable() { return this.apiKey ? undefined : 'BRAVE_SEARCH_API_KEY is not configured.' }
  async search(intent: SearchIntent, signal: AbortSignal): Promise<CandidateItem[]> {
    const url = new URL('https://api.search.brave.com/res/v1/web/search')
    url.searchParams.set('q', webQuery(intent)); url.searchParams.set('count', '10')
    const body = responseSchema.parse(await fetchJson(url, { signal, headers: { 'X-Subscription-Token': this.apiKey!, Accept: 'application/json' } }, this.fetcher))
    const leads = (body.web?.results ?? []).slice(0, 10).flatMap(row => {
      const result = resultSchema.safeParse(row)
      if (!result.success || !isPublicHttpsUrl(result.data.url)) return []
      const data = result.data
      return [recordSourceEvidence({
        id: 'web:' + createHash('sha256').update(data.url).digest('hex').slice(0, 32),
        title: plainText(data.title), description: plainText(data.description ?? '', 1200),
        productUrl: data.url, imageUrl: safeImage(data.thumbnail?.src), source: this.name,
        domain: new URL(data.url).hostname, mode: this.mode, kind: 'web-page' as const,
        fetchedAt: new Date().toISOString(), signals: {},
        // A snippet does not establish an offer price, availability, seller, or authenticity.
      })]
    })
    return Promise.all(leads.map(lead => enrichProductPage(lead, signal, this.readPage)))
  }
}
