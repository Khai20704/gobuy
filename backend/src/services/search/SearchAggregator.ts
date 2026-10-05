import { candidateItemSchema, type CandidateItem, type ProviderReport, type SearchIntent } from '@gobuy/shared'
import type { SearchProvider } from './SearchProvider.js'
import { ProviderRequestError } from './http.js'
import { CircuitBreaker } from '../CircuitBreaker.js'

export function canonicalProductUrl(value: string) {
  const url = new URL(value)
  url.hash = ''
  url.hostname = url.hostname.replace(/^www\./, '')
  for (const key of [...url.searchParams.keys()]) {
    if (/^(utm_|ref$|ref_|fbclid$|gclid$|mkcid$|mkrid$|campid$|toolid$)/i.test(key)) url.searchParams.delete(key)
  }
  url.searchParams.sort()
  url.pathname = url.pathname.replace(/\/$/, '') || '/'
  return url.toString()
}
export class SearchAggregator {
  private readonly circuits: Map<SearchProvider, CircuitBreaker>
  constructor(private readonly providers: SearchProvider[], private readonly timeoutMs = 8000,
    options: { failureThreshold?: number; cooldownMs?: number; now?: () => number } = {}) {
    this.circuits = new Map(providers.map(provider => [provider, new CircuitBreaker(options.failureThreshold, options.cooldownMs, options.now)]))
  }
  async search(intent: SearchIntent, options: { allowLLM?: boolean } = {}) {
    const results = await Promise.allSettled(this.providers.map(async provider => {
      const unavailable = options.allowLLM === false && provider.requiresLLM ? 'AI search is skipped; direct commerce sources remain available.' : provider.unavailable?.(intent)
      if (unavailable) return { items: [], report: { provider: provider.name, mode: provider.mode, status: 'skipped', count: 0, message: unavailable } as ProviderReport }
      const circuit = this.circuits.get(provider)!, ticket = circuit.acquire()
      if (ticket === undefined) return { items: [], report: { provider: provider.name, mode: provider.mode, status: 'failed', count: 0,
        message: 'Search source is temporarily cooling down. Other sources can still be used.' } as ProviderReport }
      const controller = new AbortController()
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        // The race bounds even an adapter that ignores AbortSignal.
        const rows = await Promise.race([
          Promise.resolve().then(() => provider.search(intent, controller.signal)),
          new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('timeout')) }, provider.timeoutMs ?? this.timeoutMs) }),
        ])
        if (!Array.isArray(rows)) throw new Error('Invalid provider response')
        const items = rows.slice(0, 50).flatMap(row => {
          const parsed = candidateItemSchema.safeParse(row)
          if (!parsed.success || parsed.data.mode !== provider.mode || parsed.data.source !== provider.name) return []
          return [{ ...parsed.data, domain: new URL(parsed.data.productUrl).hostname }]
        })
        circuit.success(ticket)
        return { items, report: { provider: provider.name, mode: provider.mode, status: 'ok', count: items.length,
          ...(items.length < rows.length ? { message: 'Invalid or excess provider records were discarded.' } : {}) } as ProviderReport }
      } catch (error) { circuit.failure(ticket); throw error }
      finally { clearTimeout(timer); controller.abort() }
    }))
    const unique = new Map<string, CandidateItem>()
    const reports: ProviderReport[] = []
    results.forEach((result, index) => {
      const provider = this.providers[index]
      if (result.status === 'rejected') {
        reports.push({ provider: provider.name, mode: provider.mode, status: 'failed', count: 0, message: result.reason instanceof ProviderRequestError
          ? result.reason.message : 'Provider failed, returned invalid data, or timed out. Other sources can still be used.' })
        return
      }
      reports.push(result.value.report)
      for (const item of result.value.items) {
        const key = item.mode + ':' + canonicalProductUrl(item.productUrl)
        const previous = unique.get(key)
        // Preserve marketplace facts over a search snippet; never merge unrelated seller claims.
        if (!previous || (previous.kind === 'web-page' && item.kind !== 'web-page')) unique.set(key, item)
      }
    })
    return { items: [...unique.values()], reports }
  }
}
