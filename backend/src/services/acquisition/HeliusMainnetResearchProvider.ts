import { z } from 'zod'
import { PublicKey } from '@solana/web3.js'
import { walletAddressSchema, type NFTSearchIntent, type NFTResearch } from '@gobuy/shared'
import { HeliusClient, HeliusError } from '../../nft/helius/HeliusClient.js'
import { safeImage } from '../search/http.js'
import type { NFTProviderResult } from '../nft-intelligence/marketContracts.js'
import { collectionRegistry } from './collectionRegistry.js'

const address = walletAddressSchema.refine(value => { try { return new PublicKey(value).toBase58() === value } catch { return false } })
const assetSchema = z.object({ id: address, interface: z.enum(['V1_NFT', 'ProgrammableNFT', 'MplCoreAsset', 'MplCoreCollection']), burnt: z.literal(false),
  content: z.object({ metadata: z.object({ name: z.string().optional(),
    attributes: z.array(z.object({ trait_type: z.string(), value: z.union([z.string(), z.number(), z.boolean()]) })).optional() }).optional(),
    links: z.object({ image: z.string().optional() }).optional() }).optional(),
  grouping: z.array(z.object({ group_key: z.string(), group_value: address, verified: z.boolean().optional(),
    group_verified: z.boolean().optional() })).default([]) })
type Asset = z.infer<typeof assetSchema>
type Resolution = { collectionId: string; name: string; source: string; network: 'mainnet'; verified: true }
const normalize = (value: string) => value.trim().toLowerCase().replace(/\s+/g, '_')

// Bounded TTL cache also coalesces simultaneous identical lookups. Failures are never cached.
class ReadCache<T> {
  private values = new Map<string, { until: number; value: Promise<T> }>()
  constructor(private ttl: number) {}
  get(key: string, read: () => Promise<T>): Promise<T> {
    const entry = this.values.get(key)
    if (entry && entry.until > Date.now()) return entry.value
    this.values.delete(key)
    if (this.values.size >= 100) this.values.delete(this.values.keys().next().value!)
    const value = read().catch(error => { if (this.values.get(key)?.value === value) this.values.delete(key); throw error })
    this.values.set(key, { until: Date.now() + this.ttl, value })
    return value
  }
}

export class CollectionResolver {
  private cache = new ReadCache<Resolution | undefined>(300_000)
  constructor(private client: Pick<HeliusClient, 'call'>) {}
  resolve(query: string, signal: AbortSignal) {
    const identity = collectionRegistry.find(entry => entry.aliases.includes(normalize(query)))
    const mint = identity?.collectionId ?? (address.safeParse(query).success ? query : undefined)
    if (!mint) return Promise.resolve(undefined)
    return this.cache.get(mint, async () => {
      const source = identity ? `${identity.source} + Helius Mainnet` : 'Helius collection address'
      let raw: unknown
      try { raw = await this.client.call('getAsset', { id: mint, displayOptions: { showUnverifiedCollections: false } }, signal) }
      catch (error) { if (error instanceof HeliusError && error.code === 'ASSET_NOT_FOUND') return undefined; throw error }
      const parsed = assetSchema.safeParse(raw)
      if (!parsed.success || parsed.data.id !== mint) return undefined
      if (identity && normalize(parsed.data.content?.metadata?.name ?? '') !== normalize(identity.name)) return undefined
      const collectionId = mint
      if (!collectionId) return undefined
      console.info('[Collection Resolver]', JSON.stringify({ network: 'mainnet', resolved: true, collectionId }))
      return { collectionId, name: parsed.data.content?.metadata?.name || identity?.name || query,
        source, network: 'mainnet' as const, verified: true as const }
    })
  }
}

export class HeliusMainnetResearchProvider {
  readonly name = 'helius-mainnet-research'
  private pages = new ReadCache<{ assets: Asset[]; checked: number; checkedAt: string }>(60_000)
  private resolver: CollectionResolver
  constructor(private client: Pick<HeliusClient, 'call'> = new HeliusClient(process.env, fetch, 10000, 'mainnet')) {
    this.resolver = new CollectionResolver(client)
  }
  async search(intent: NFTSearchIntent, signal: AbortSignal): Promise<NFTProviderResult> {
    const query = intent.collectionAddress ?? intent.collectionQuery ?? intent.collectionSymbol
    if (!query) return { candidates: [] }
    const resolution = await this.resolver.resolve(query, signal)
    const evidence: NFTResearch = { query, network: 'mainnet', source: 'Helius Mainnet', verified: false, assetsChecked: 0,
      priceSource: 'unavailable', checkedAt: new Date().toISOString(), execution: 'MAINNET_READ_ONLY', assets: [] }
    if (!resolution) return { candidates: [], status: 'COLLECTION_UNRESOLVED', research: evidence }
    const page = await this.pages.get(resolution.collectionId, async () => {
      const raw = await this.client.call('getAssetsByGroup', { groupKey: 'collection', groupValue: resolution.collectionId,
        page: 1, limit: 20, options: { showUnverifiedCollections: false } }, signal)
      const parsed = z.object({ items: z.array(z.unknown()).max(20) }).safeParse(raw)
      if (!parsed.success) throw new HeliusError('INVALID_RESPONSE')
      const assets = parsed.data.items.flatMap(item => {
        const row = assetSchema.safeParse(item)
        return row.success && row.data.grouping.some(group => group.group_key === 'collection' && group.group_value === resolution.collectionId
          && group.verified !== false && group.group_verified !== false) ? [row.data] : []
      })
      if (parsed.data.items.length && !assets.length) throw new HeliusError('INVALID_RESPONSE')
      console.info('[Helius]', JSON.stringify({ method: 'getAssetsByGroup', items: parsed.data.items.length, network: 'mainnet' }))
      return { assets, checked: parsed.data.items.length, checkedAt: new Date().toISOString() }
    })
    const assets = page.assets.filter(asset => !intent.excludedMints.includes(asset.id)).map(asset => {
      const attributes = (asset.content?.metadata?.attributes ?? []).slice(0, 40).map(a => ({ name: a.trait_type, value: String(a.value) }))
      const name = asset.content?.metadata?.name || asset.id
      const text = normalize(name + ' ' + attributes.map(a => a.value).join(' '))
      const matchScore = intent.terms.filter(term => text.includes(normalize(term))).length
      return { mint: asset.id, network: 'mainnet' as const, name, image: safeImage(asset.content?.links?.image) ?? null,
        attributes, matchScore, reasons: ['Thuộc collection được kiểm tra qua Helius; thứ tự chỉ theo độ khớp metadata, không phải giá trị đầu tư.'] }
    }).sort((a, b) => b.matchScore - a.matchScore || a.mint.localeCompare(b.mint)).slice(0, 3)
    console.info('[NFT Ranking]', JSON.stringify({ candidates: page.assets.length, ranked: assets.length, network: 'mainnet' }))
    return { candidates: [], status: !page.assets.length ? 'NO_ASSETS_FOUND' : intent.objective && intent.objective !== 'GENERAL_MATCH'
      || intent.requestKind === 'investment_research' ? 'INSUFFICIENT_MARKET_DATA' : 'MAINNET_READ_ONLY',
      research: { ...evidence, collection: resolution.name, collectionId: resolution.collectionId, resolverSource: resolution.source,
        verified: true, assetsChecked: page.checked, checkedAt: page.checkedAt, assets },
      warnings: ['Helius DAS không cung cấp giá listing, floor, volume hoặc lịch sử bán trong luồng này. Không đủ dữ liệu để kết luận NFT rẻ nhất, đắt nhất hay đáng đầu tư.'] }
  }
  async refresh() { return undefined }
}
