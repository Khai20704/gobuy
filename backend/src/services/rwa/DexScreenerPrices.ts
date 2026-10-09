import { PublicKey } from '@solana/web3.js'
import { z } from 'zod'
import { fetchJson, type Fetcher } from '../search/http.js'

const pairSchema = z.object({ chainId: z.string().regex(/^[a-z0-9-]+$/), pairAddress: z.string().min(1).max(150),
  baseToken: z.object({ address: z.string(), symbol: z.string().max(80), name: z.string().max(200) }),
  priceUsd: z.string().nullable().optional() })
export type UnverifiedPrice = { mint: string; symbol: string; priceUsd: number | null; pair: string; chain: string; url: string }

/** Read-only market observations. Never grants identity, approval or execution authority. */
export class DexScreenerPrices {
  constructor(private readonly fetcher: Fetcher = fetch) {}
  async lookup(identifier: { mint?: string; symbol?: string }): Promise<UnverifiedPrice[]> {
    const query = identifier.mint ?? identifier.symbol
    if (!query) return []
    const [chain, address] = identifier.mint?.includes(':') ? identifier.mint.split(':') : ['solana', identifier.mint]
    const url = identifier.mint
      ? `https://api.dexscreener.com/token-pairs/v1/${encodeURIComponent(chain)}/${encodeURIComponent(address!)}`
      : `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(query)}`
    const raw = await fetchJson(url, { signal: AbortSignal.timeout(8000) }, this.fetcher)
    const pairs = z.array(z.unknown()).max(1000).parse(identifier.mint ? raw
      : z.object({ pairs: z.array(z.unknown()).nullable() }).parse(raw).pairs ?? [])
    const rows: UnverifiedPrice[] = []
    for (const rawPair of pairs) {
      const parsed = pairSchema.safeParse(rawPair)
      if (!parsed.success) continue
      const pair = parsed.data, token = pair.baseToken
      if (identifier.mint && pair.chainId !== chain) continue
      // USD price describes the base token only; never attribute it to a matching quote token.
      if (identifier.mint ? (chain === 'solana' ? token.address !== address : token.address.toLowerCase() !== address?.toLowerCase())
        : ![token.symbol, token.name].some(value => value.toLowerCase() === query.toLowerCase())) continue
      if (pair.chainId === 'solana') {
        try { if (new PublicKey(token.address).toBase58() !== token.address) continue } catch { continue }
      }
      const price = Number(pair.priceUsd)
      rows.push({ mint: token.address, symbol: token.symbol, pair: pair.pairAddress, chain: pair.chainId,
        url: `https://dexscreener.com/${pair.chainId}/${encodeURIComponent(pair.pairAddress)}`,
        priceUsd: Number.isFinite(price) && price > 0 ? price : null })
    }
    // Stable ordering, never pick an identity based on liquidity/popularity.
    return rows.sort((a, b) => a.chain.localeCompare(b.chain) || a.mint.localeCompare(b.mint) || a.pair.localeCompare(b.pair))
  }
}
