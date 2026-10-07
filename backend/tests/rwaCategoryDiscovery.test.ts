import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Connection } from '@solana/web3.js'
import { namedNFTQuery, type RWAAsset } from '@gobuy/shared'
import type { AssetStore } from '../src/persistence/AssetStore.ts'
import { extractNamedCollectionQuery } from '../src/services/acquisition/intentLanguage.ts'
import { AssetResolver } from '../src/services/rwa/AssetResolver.ts'
import type { JupiterClient } from '../src/services/jupiter/JupiterClient.ts'
import { JupiterQuoteService } from '../src/services/jupiter/JupiterQuoteService.ts'
import { parseRWAIntent } from '../src/services/rwa/RWAIntent.ts'
import { MAINNET_GENESIS, RWARegistry } from '../src/services/rwa/RWARegistry.ts'
import { RWAService, type SavedRWA } from '../src/services/rwa/RWAService.ts'
import { rankApprovedCandidates } from '../src/services/rwa/RWARecommendation.ts'

/**
 * SPECIFIC_ASSET vs CATEGORY_DISCOVERY.
 *
 * The rules under test: a request that names no asset is a category search, never a lookup of the
 * whole sentence as a symbol or a canonical mint; category discovery only ever ranks already-approved
 * candidates; an empty category says so instead of inventing a token; and nothing RWA ever falls
 * through to the NFT flow.
 */

const NVDAX_MINT = 'Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh'
const TSLAX_MINT = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
const GOLDX_MINT = 'So11111111111111111111111111111111111111112'
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
const NOW = new Date().toISOString()

const rwa = (mint: string, symbol: string, name: string, underlying: string, category: RWAAsset['category']): RWAAsset =>
  ({ mint, symbol, name, issuer: 'Backed Assets', category, underlying, decimals: 6, verified: true,
    allowedForSwap: true, verificationSource: 'https://backed.fi/xstocks', updatedAt: NOW })

const nvdax = rwa(NVDAX_MINT, 'NVDAx', 'NVIDIA xStock', 'NVDA', 'EQUITY')
const tsalx = rwa(TSLAX_MINT, 'TSLAx', 'Tesla xStock', 'TSLA', 'EQUITY')
const goldx = rwa(GOLDX_MINT, 'GOLDx', 'Gold xStock', 'XAU', 'GOLD')

const mainnetRpc = {
  getGenesisHash: async () => MAINNET_GENESIS,
  getParsedAccountInfo: async () => ({ value: { owner: { toBase58: () => TOKEN_PROGRAM },
    data: { parsed: { type: 'mint', info: { decimals: 6, isInitialized: true } } } } }),
} as unknown as Connection

const nftEvidence = (text: string) => !!extractNamedCollectionQuery(text) || !!namedNFTQuery(text)
const registryWith = (assets: RWAAsset[]) => new RWARegistry(assets, mainnetRpc)

test('specific identifiers survive RWA and currency words, including unknown xStocks without money', () => {
  const resolver = new AssetResolver(registryWith([nvdax]), () => true)
  for (const text of ['Find RWA UNKWN', 'Buy 100 USDC UNKWN', 'Find FOOx']) {
    const result = resolver.resolve(text)
    assert.equal(result.assetType, 'RWA')
    assert.equal(result.blocked, true)
    assert.notEqual(result.reason, 'category_discovery')
  }
  assert.equal(resolver.resolve('Find NVIDIA xStock').mint, NVDAX_MINT)
})

test('category classification never calls canonical resolution or NFT discovery', () => {
  const registry = registryWith([nvdax])
  let lookups = 0
  registry.resolve = () => { lookups++; throw new Error('must not resolve a category') }
  const resolver = new AssetResolver(registry, () => assert.fail('must not query NFT evidence'))
  assert.equal(resolver.resolve('Find RWA technology under 100 USDC').reason, 'category_discovery')
  assert.equal(lookups, 0)
})

test('budget ranking filters expensive assets and does not claim an unknown price exceeds budget', () => {
  const ranked = rankApprovedCandidates([{ asset: nvdax, priceUsd: 150 }, { asset: tsalx, priceUsd: null }],
    { amount: 100, currency: 'USDC' })
  assert.equal(ranked.length, 1)
  assert.equal(ranked[0].withinBudget, null)
  assert.equal(ranked[0].reasons.some(reason => /above/.test(reason)), false)
})

class MemoryStore<T> implements AssetStore<T> {
  private readonly rows = new Map<string, T>()
  async get(userId: string, id: string) { return this.rows.get(userId + ':' + id) }
  async put(userId: string, id: string, value: T, once = false) {
    if (once && this.rows.has(userId + ':' + id)) return
    this.rows.set(userId + ':' + id, value)
  }
  async list(userId: string) { return [...this.rows.entries()].filter(([key]) => key.startsWith(userId + ':')).map(([, value]) => value) }
  async take(userId: string, id: string) { const value = this.rows.get(userId + ':' + id); this.rows.delete(userId + ':' + id); return value }
}

/** Jupiter stub keyed by output mint: the observed unit price equals `prices[outputMint]` at 6 decimals. */
function quotesByMint(prices: Record<string, number>): JupiterQuoteService {
  const client = { request: async (_path: string, params: Record<string, string>) => {
    const price = prices[params.outputMint] ?? 1
    const out = String(Math.max(1, Math.round(Number(params.amount) / price)))
    return { inputMint: params.inputMint, outputMint: params.outputMint, inAmount: params.amount,
      outAmount: out, otherAmountThreshold: out, slippageBps: Number(params.slippageBps), swapMode: 'ExactIn',
      routePlan: [{ swapInfo: { label: 'Jupiter' } }] }
  } } as unknown as JupiterClient
  return new JupiterQuoteService(client)
}

function serviceFor(assets: RWAAsset[]) {
  const registry = registryWith(assets)
  const quotes = quotesByMint({ [NVDAX_MINT]: 20, [TSLAX_MINT]: 30, [GOLDX_MINT]: 5 })
  return new RWAService(registry, { quotes, cached: new MemoryStore<SavedRWA>(),
    resolver: new AssetResolver(registry, nftEvidence) })
}

test('"Tìm cho tôi một RWA công nghệ đáng mua trong khoảng 100 USDC" parses as a category discovery', () => {
  const intent = parseRWAIntent('Tìm cho tôi một RWA công nghệ đáng mua trong khoảng 100 USDC', [nvdax, tsalx, goldx])
  assert.equal(intent.requestKind, 'CATEGORY_DISCOVERY')
  assert.equal(intent.symbol, undefined)
  assert.equal(intent.mint, undefined)
  assert.equal(intent.desiredCategory, 'TECHNOLOGY')
  assert.equal(intent.amount, '100000000')
  assert.equal(intent.currency, 'USDC')
  assert.equal(intent.action, 'SEARCH')
})

test('the whole sentence is never used as an asset identifier or a mint lookup key', () => {
  const text = 'Tìm cho tôi một RWA công nghệ đáng mua trong khoảng 100 USDC'
  const resolution = new AssetResolver(registryWith([nvdax, tsalx, goldx]), nftEvidence).resolve(text)
  assert.equal(resolution.assetType, 'RWA')
  assert.equal(resolution.reason, 'category_discovery')
  assert.equal(resolution.blocked, false)
  assert.equal(resolution.symbol, undefined)
  assert.equal(resolution.category, 'TECHNOLOGY')
  assert.deepEqual(resolution.budget, { amount: 100, currency: 'USDC' })
})

test('category discovery ranks only approved technology candidates and skips other categories', async () => {
  const reply = await serviceFor([nvdax, tsalx, goldx])
    .discover('user-1', 'Tìm cho tôi một RWA công nghệ đáng mua trong khoảng 100 USDC')
  assert.equal(reply.status, 'RECOMMENDED')
  assert.equal(reply.intent?.requestKind, 'CATEGORY_DISCOVERY')
  assert.equal(reply.recommendations?.length, 2)
  assert.equal(reply.recommendations?.some(item => item.symbol === 'GOLDx'), false)
  const cheapest = reply.recommendations?.[0]
  assert.equal(cheapest?.symbol, 'NVDAx')
  assert.equal(cheapest?.withinBudget, true)
  assert.equal(cheapest?.priceUsd, 20)
})

test('"Tìm RWA technology dưới 100 USDC" is a category discovery in English too', () => {
  const intent = parseRWAIntent('Tìm RWA technology dưới 100 USDC', [nvdax, tsalx, goldx])
  assert.equal(intent.requestKind, 'CATEGORY_DISCOVERY')
  assert.equal(intent.desiredCategory, 'TECHNOLOGY')
  const resolution = new AssetResolver(registryWith([nvdax]), nftEvidence).resolve('Recommend a technology RWA around 100 USDC')
  assert.equal(resolution.reason, 'category_discovery')
  assert.equal(resolution.category, 'TECHNOLOGY')
})

test('a specific NVDAx lookup resolves through the approved list', () => {
  const resolution = new AssetResolver(registryWith([nvdax]), nftEvidence).resolve('Tìm NVDAx')
  assert.equal(resolution.assetType, 'RWA')
  assert.equal(resolution.reason, 'approved_mint')
  assert.equal(resolution.symbol, 'NVDAx')
  assert.equal(resolution.blocked, false)
})

test('a specific NVDAx BUY keeps spend authority and the exact approved mint', () => {
  const intent = parseRWAIntent('Mua 100 USDC NVDAx', [nvdax])
  assert.equal(intent.requestKind, 'SPECIFIC_ASSET')
  assert.equal(intent.symbol, 'NVDAx')
  assert.equal(intent.action, 'BUY')
  assert.equal(intent.amount, '100000000')
  const resolution = new AssetResolver(registryWith([nvdax]), nftEvidence).resolve('Mua 100 USDC NVDAx')
  assert.equal(resolution.reason, 'approved_mint')
  assert.equal(resolution.approved?.mint, NVDAX_MINT)
})

test('an unknown specific RWA is blocked and never becomes an NFT', () => {
  // An unapproved, symbol-shaped token carrying a spend is an RWA attempt: it blocks, never an NFT.
  const resolution = new AssetResolver(registryWith([nvdax]), nftEvidence).resolve('Mua 100 USDC FOOx')
  assert.equal(resolution.assetType, 'RWA')
  assert.equal(resolution.blocked, true)
  assert.equal(resolution.reason, 'unapproved_symbol')
  assert.equal(resolution.symbol, 'FOOx')
})

test('a category with no approved candidates says so instead of inventing a token', async () => {
  const reply = await serviceFor([goldx]).discover('user-1', 'Tìm RWA công nghệ dưới 100 USDC')
  assert.equal(reply.status, 'REJECTED')
  assert.match(reply.message, /No approved technology RWA candidates are currently available/)
})

test('revoked technology assets cannot enter recommendations', async () => {
  const reply = await serviceFor([{ ...nvdax, verified: false }, { ...tsalx, allowedForSwap: false }])
    .discover('user-1', 'Recommend a technology RWA around 100 USDC')
  assert.equal(reply.status, 'REJECTED')
  assert.match(reply.message, /No approved technology RWA candidates/)
  assert.equal(reply.recommendations, undefined)
})

test('an RWA category request never falls through to NFT discovery', () => {
  // nftEvidence always true: the resolver must still refuse to route a category RWA request to NFT.
  const always = () => true
  const resolver = new AssetResolver(registryWith([nvdax, tsalx, goldx]), always)
  const category = resolver.resolve('Có RWA công nghệ nào đáng mua không?')
  assert.equal(category.assetType, 'RWA')
  assert.equal(category.reason, 'category_discovery')
  const specific = resolver.resolve('Giá TSLAx bao nhiêu?')
  assert.equal(specific.assetType, 'RWA')
  assert.equal(specific.reason, 'approved_mint')
})
