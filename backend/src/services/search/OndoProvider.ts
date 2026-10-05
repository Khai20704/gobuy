import { z } from 'zod'
import { publicUrlSchema, type CandidateItem, type SearchIntent } from '@gobuy/shared'
import { fetchJson, type Fetcher } from './http.js'
import type { SearchProvider } from './SearchProvider.js'
import { recordSourceEvidence } from '../verification/evidence.js'

// Normalized feed contract for a deployment-owned Ondo data gateway. No invented public endpoint/APY.
const rowSchema = z.object({ token: z.string().min(1).max(80), name: z.string().min(1).max(200),
  network: z.literal('Solana'), price: z.number().finite().positive(), currency: z.enum(['USD', 'USDC']),
  sourceUrl: publicUrlSchema.refine(v => ['ondo.finance', 'www.ondo.finance', 'app.ondo.finance', 'docs.ondo.finance'].includes(new URL(v).hostname)),
  apy: z.number().finite().min(0).max(100).optional(), apySource: publicUrlSchema.optional(), observedAt: z.iso.datetime(),
  riskLevel: z.number().int().min(0).max(3), risks: z.array(z.string().min(1).max(300)).min(1).max(10),
}).strict()
export class OndoProvider implements SearchProvider {
  readonly name = 'Ondo'
  readonly mode = 'real' as const
  constructor(private readonly endpoint?: string, private readonly fetcher: Fetcher = fetch) {
    if (endpoint) publicUrlSchema.parse(endpoint)
  }
  unavailable(intent: SearchIntent) {
    if (intent.category !== 'rwa') return 'RWA requests only.'
    if (!this.endpoint) return 'Ondo data gateway is not configured. No live yield is assumed.'
  }
  async search(_intent: SearchIntent, signal: AbortSignal): Promise<CandidateItem[]> {
    if (!this.endpoint) return []
    const rows = z.array(z.unknown()).max(50).parse(await fetchJson(this.endpoint, { signal }, this.fetcher))
    return rows.flatMap(row => {
      const result = rowSchema.safeParse(row)
      if (!result.success) return []
      const r = result.data, age = Date.now() - Date.parse(r.observedAt)
      if (age < -5000 || age > 86400000 || r.apy !== undefined && !r.apySource) return []
      return [recordSourceEvidence({ id: `ondo:${r.network}:${r.token}`, title: r.name, price: r.price, currency: r.currency,
        productUrl: r.sourceUrl, source: this.name, domain: new URL(r.sourceUrl).hostname, mode: this.mode, kind: 'rwa',
        fetchedAt: new Date().toISOString(), signals: {}, seller: { name: 'Ondo' },
        rwa: { protocol: 'Ondo', token: r.token, network: r.network, apy: r.apy, apySource: r.apySource,
          riskLevel: r.riskLevel, risks: r.risks, observedAt: r.observedAt } })]
    })
  }
}
