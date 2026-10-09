import { Connection, PublicKey } from '@solana/web3.js'
import { z } from 'zod'
import { rwaAssetSchema, type RWAAsset } from '@gobuy/shared'
import { fetchJson, type Fetcher } from '../search/http.js'
import { MAINNET_GENESIS, RWA_REGISTRY_CAPACITY } from './RWARegistry.js'

export const XSTOCKS_ASSETS_URL = 'https://api.xstocks.fi/api/v2/public/assets'
const nodeSchema = z.object({ symbol: z.string().min(1).max(24), name: z.string().min(1).max(120),
  isTradingHalted: z.boolean(), underlying: z.object({ symbol: z.string().min(1).max(100),
    type: z.enum(['Equity', 'ETF']).nullable() }).nullable(),
  sector: z.string().min(1).max(120).optional(), deployments: z.array(z.record(z.string(), z.unknown())).max(30) })
const pageSchema = z.object({ nodes: z.array(nodeSchema).max(100),
  page: z.object({ currentPage: z.number().int().nonnegative(), hasNextPage: z.boolean() }) })

/** Field mapping confirmed against the issuer API response supplied by the operator.
 * No guessed alternate field names, symbol-to-mint lookup, market filters or LLM authority.
 */
export type DeploymentMapping = { networkField: string; mintField: string; solanaNetwork: string }
export const XSTOCKS_DEPLOYMENT_MAPPING: DeploymentMapping = { networkField: 'network', mintField: 'address', solanaNetwork: 'Solana' }
export class XStocksSync {
  private rateLimitRetries = 0
  constructor(private readonly mapping: DeploymentMapping = XSTOCKS_DEPLOYMENT_MAPPING, private readonly fetcher: Fetcher = fetch,
    private readonly rpc = new Connection(process.env.RWA_SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com', {
      commitment: 'confirmed', disableRetryOnRateLimit: true,
    }), private readonly pause: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms)),
    private readonly progress: (count: number) => void = () => {}) {}

  private async readRpc<T>(read: () => Promise<T>): Promise<T> {
    for (;;) {
      // Keep sequential mint checks below public-RPC per-method request limits.
      await this.pause(1000)
      try { return await read() }
      catch (error) {
        if (!(error instanceof Error) || !/\b429\b|too many requests/i.test(error.message)) throw error
        if (this.rateLimitRetries >= 3) {
          throw new Error('RPC Solana bị giới hạn 429 sau 3 lần thử lại trong lượt đồng bộ. Chưa ghi allowlist. Đợi rồi chạy lại hoặc cấu hình RWA_SOLANA_RPC_URL bằng RPC mainnet riêng.')
        }
        await this.pause(5000 * 2 ** this.rateLimitRetries++)
      }
    }
  }

  async collect(): Promise<RWAAsset[]> {
    this.rateLimitRetries = 0
    let checkedSolana = false
    const assets: RWAAsset[] = [], seen = new Set<string>(), symbols = new Set<string>()
    for (let page = 0; page < 100; page++) {
      const response = pageSchema.parse(await fetchJson(`${XSTOCKS_ASSETS_URL}?page=${page}&pageSize=100`,
        { signal: AbortSignal.timeout(15000) }, this.fetcher))
      if (response.page.currentPage !== page || (!response.nodes.length && response.page.hasNextPage)) throw new Error('Invalid issuer pagination.')
      for (const node of response.nodes) {
        if (!node.underlying) continue // no backing collateral: not an approved equity/ETF
        const evmNetworks: Record<string, string> = { Ethereum: 'ethereum', Base: 'base', Arbitrum: 'arbitrum',
          BinanceSmartChain: 'bsc', Polygon: 'polygon', Avalanche: 'avalanche', Gnosis: 'gnosis', Mantle: 'mantle', Ink: 'ink' }
        for (const deployment of node.deployments) {
          const chain = evmNetworks[String(deployment[this.mapping.networkField])]
          if (!chain) continue
          const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/).parse(deployment[this.mapping.mintField]).toLowerCase()
          const identity = `${chain}:${address}`
          if (seen.has(identity) || symbols.has(`${chain}:${node.symbol.toLowerCase()}`)) throw new Error('Duplicate issuer deployment.')
          seen.add(identity); symbols.add(`${chain}:${node.symbol.toLowerCase()}`)
          assets.push(rwaAssetSchema.parse({ mint: identity, symbol: node.symbol, name: node.name, issuer: 'Backed Assets (xStocks)',
            underlying: node.underlying.symbol, category: node.underlying.type === 'ETF' ? 'ETF' : node.underlying.type === 'Equity' ? 'EQUITY' : 'OTHER',
            ...(node.sector ? { sector: node.sector } : {}), verified: true, allowedForSwap: !node.isTradingHalted,
            network: 'mainnet', syncSource: 'xstocks-v2', updatedAt: new Date().toISOString(),
            verificationSource: `${XSTOCKS_ASSETS_URL}/${encodeURIComponent(node.symbol)}` }))
          if (assets.length > RWA_REGISTRY_CAPACITY) throw new Error(`Issuer list exceeds registry capacity (${RWA_REGISTRY_CAPACITY}); no partial sync.`)
          if (assets.length % 25 === 0) this.progress(assets.length)
        }
        const deployments = node.deployments.filter(deployment => {
          if (typeof deployment[this.mapping.networkField] !== 'string') throw new Error('Unknown deployment network schema; no approvals written.')
          return deployment[this.mapping.networkField] === this.mapping.solanaNetwork
        })
        if (deployments.length > 1) throw new Error('Ambiguous issuer Solana deployments.')
        if (!deployments.length) continue
        if (!checkedSolana) {
          if (await this.readRpc(() => this.rpc.getGenesisHash()) !== MAINNET_GENESIS) throw new Error('Issuer sync requires Solana mainnet RPC.')
          checkedSolana = true
        }
        const mint = z.string().parse(deployments[0][this.mapping.mintField])
        const key = new PublicKey(mint)
        if (key.toBase58() !== mint || seen.has(mint) || symbols.has(node.symbol.toLowerCase())) throw new Error('Duplicate or noncanonical issuer identity.')
        seen.add(mint); symbols.add(node.symbol.toLowerCase())
        const account = (await this.readRpc(() => this.rpc.getParsedAccountInfo(key))).value
        if (!account || !['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'].includes(account.owner.toBase58())
          || !('parsed' in account.data) || account.data.parsed.type !== 'mint' || account.data.parsed.info.isInitialized !== true) {
          throw new Error('Issuer mint is not an initialized SPL mint on mainnet.')
        }
        assets.push(rwaAssetSchema.parse({ mint, symbol: node.symbol, name: node.name, issuer: 'Backed Assets (xStocks)',
          category: node.underlying.type === 'ETF' ? 'ETF' : node.underlying.type === 'Equity' ? 'EQUITY' : 'OTHER', underlying: node.underlying.symbol,
          ...(node.sector ? { sector: node.sector } : {}), decimals: account.data.parsed.info.decimals,
          verified: true, allowedForSwap: !node.isTradingHalted, network: 'mainnet', syncSource: 'xstocks-v2',
          verificationSource: `${XSTOCKS_ASSETS_URL}/${encodeURIComponent(node.symbol)}`, updatedAt: new Date().toISOString() }))
        if (assets.length > RWA_REGISTRY_CAPACITY) throw new Error(`Issuer list exceeds registry capacity (${RWA_REGISTRY_CAPACITY}); no partial sync.`)
        if (assets.length % 25 === 0) this.progress(assets.length)
      }
      if (!response.page.hasNextPage) {
        if (!assets.length) throw new Error('Empty issuer Solana list; refusing to revoke or replace approvals.')
        return assets
      }
    }
    throw new Error('Issuer pagination limit exceeded; no partial sync.')
  }
}

/** Manual rows and revocations always win. Only this adapter's rows may be refreshed/retired. */
export function mergeIssuerAssets(existing: RWAAsset[], incoming: RWAAsset[]): RWAAsset[] {
  if (incoming.some(row => row.syncSource !== 'xstocks-v2')) throw new Error('Unexpected issuer source.')
  const current = new Map(incoming.map(row => [row.mint, row]))
  const result = existing.map(row => {
    const fresh = current.get(row.mint); current.delete(row.mint)
    if (row.syncSource !== 'xstocks-v2') return row
    if (!fresh) return { ...row, verified: false, allowedForSwap: false }
    return { ...row, ...fresh, verified: row.verified && fresh.verified,
      allowedForSwap: row.allowedForSwap && fresh.allowedForSwap,
      ...(row.sector ? { sector: row.sector } : {}),
      ...(row.eligibleWallets ? { eligibleWallets: row.eligibleWallets } : {}) }
  })
  result.push(...current.values())
  if (result.length > RWA_REGISTRY_CAPACITY) throw new Error(`Merged registry exceeds capacity (${RWA_REGISTRY_CAPACITY}).`)
  return result
}
