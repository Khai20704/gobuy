import { createHash } from 'node:crypto'
import { z } from 'zod'
import { isPublicHttpsUrl, type CandidateItem, type SearchIntent } from '@gobuy/shared'
import type { SearchProvider } from './SearchProvider.js'
import { fetchJson, plainText, safeImage, type Fetcher } from './http.js'
import { recordSourceEvidence } from '../verification/evidence.js'
import { enrichProductPage, fetchPublicHtml, type PageReader } from './productPage.js'
import { productSearchQuery } from './searchQuery.js'

const responseSchema = z.object({
  search_metadata: z.object({ status: z.literal('Success') }),
  organic_results: z.array(z.unknown()).max(100).optional(),
})
const resultSchema = z.object({ title: z.string(), link: z.string(), snippet: z.string().nullish(), thumbnail: z.string().nullish() })

export class SerpApiProvider implements SearchProvider {
  readonly name = 'SerpApi Google Search'
  readonly mode = 'real' as const
  readonly timeoutMs = 30000
  constructor(private readonly apiKey?: string, private readonly fetcher: Fetcher = fetch, private readonly readPage: PageReader = fetchPublicHtml) {}
  unavailable() { return this.apiKey?.trim() ? undefined : 'SERPAPI_KEY is not configured.' }
  async search(intent: SearchIntent, signal: AbortSignal): Promise<CandidateItem[]> {
    const url = new URL('https://serpapi.com/search.json')
    url.searchParams.set('engine', 'google')
    url.searchParams.set('api_key', this.apiKey!)
    url.searchParams.set('q', productSearchQuery(intent))
    if (intent.preferences.shippingCountry === 'VN' || intent.currency === 'VND') {
      url.searchParams.set('gl', 'vn'); url.searchParams.set('hl', 'vi')
    }
    // Never log the request URL: SerpApi authenticates through its query string.
    const body = responseSchema.parse(await fetchJson(url, { signal, headers: { Accept: 'application/json' } }, this.fetcher))
    const leads = (body.organic_results ?? []).slice(0, 10).flatMap(row => {
      const parsed = resultSchema.safeParse(row)
      if (!parsed.success || !isPublicHttpsUrl(parsed.data.link)) return []
      const data = parsed.data
      return [recordSourceEvidence({
        id: 'serp:' + createHash('sha256').update(data.link).digest('hex').slice(0, 32),
        title: plainText(data.title), description: plainText(data.snippet ?? '', 1200),
        productUrl: data.link, imageUrl: safeImage(data.thumbnail ?? undefined), source: this.name,
        domain: new URL(data.link).hostname, mode: this.mode, kind: 'web-page' as const,
        fetchedAt: new Date().toISOString(), signals: {},
      })]
    })
    // Prices and seller facts must come from the product page, never a search snippet.
    return Promise.all(leads.map(lead => enrichProductPage(lead, signal, this.readPage)))
  }
}
