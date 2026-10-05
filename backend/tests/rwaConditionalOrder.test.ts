import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Connection } from '@solana/web3.js'
import { namedNFTQuery, type RWAAsset, type RWAOrder } from '@gobuy/shared'
import type { AssetStore } from '../src/persistence/AssetStore.ts'
import { extractNamedCollectionQuery } from '../src/services/acquisition/intentLanguage.ts'
import { AssetResolver } from '../src/services/rwa/AssetResolver.ts'
import type { JupiterClient } from '../src/services/jupiter/JupiterClient.ts'
import { JupiterQuoteService } from '../src/services/jupiter/JupiterQuoteService.ts'
import { parseRWAIntent } from '../src/services/rwa/RWAIntent.ts'
import { RWAConditionalOrders, quantityUnits } from '../src/services/rwa/RWAConditionalOrders.ts'
import { MAINNET_GENESIS, RWARegistry } from '../src/services/rwa/RWARegistry.ts'
import { RWAService, type SavedRWA } from '../src/services/rwa/RWAService.ts'

/**
 * RWA routing, parsing and conditional orders.
 *
 * The rules under test: only an exact approved mint makes a token an RWA; a failed RWA lookup never
 * becomes an NFT purchase; 100 USDC is money spent and not a quantity; a quantity with a SOL ceiling
 * is not a spend; an unmet price waits instead of failing; and the same conditional order is never
 * created or executed twice.
 */

const NVDAX_MINT = 'So11111111111111111111111111111111111111112'
const OWNER = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'

const nvdax: RWAAsset = {
  mint: NVDAX_MINT, symbol: 'NVDAx', name: 'NVIDIA xStock', issuer: 'Backed Assets',
  category: 'EQUITY', underlying: 'NVDA', decimals: 6, verified: true, allowedForSwap: true,
  verificationSource: 'https://backed.fi/xstocks', updatedAt: new Date().toISOString(),
}

/** Mainnet RPC stub: genesis must be mainnet and the mint must be an SPL mint with matching decimals. */
const mainnetRpc = {
  getGenesisHash: async () => MAINNET_GENESIS,
  getParsedAccountInfo: async () => ({ value: { owner: { toBase58: () => TOKEN_PROGRAM },
    data: { parsed: { type: 'mint', info: { decimals: 6, isInitialized: true } } } } }),
} as unknown as Connection

/** The predicate the investment route injects, so NFT routing is tested against real helpers. */
const nftEvidence = (text: string) => !!extractNamedCollectionQuery(text) || !!namedNFTQuery(text)

function registryWith(assets: RWAAsset[]) { return new RWARegistry(assets, mainnetRpc) }

class MemoryStore<T> implements AssetStore<T> {
  private readonly rows = new Map<string, T>()
  async get(userId: string, id: string) { return this.rows.get(userId + ':' + id) }
  async put(userId: string, id: string, value: T, once = false) {
    if (once && this.rows.has(userId + ':' + id)) return
    this.rows.set(userId + ':' + id, value)
  }
  async list(userId: string) { return [...this.rows.entries()].filter(([key]) => key.startsWith(userId + ':')).map(([, value]) => value) }
  async take(userId: string, id: string) { const value = this.rows.get(userId + ':' + id); this.rows.delete(userId + ':' + id); return value }
  get count() { return this.rows.size }
}

/** Jupiter stub: `price` drives the USDC→asset quote so the observed unit price is deterministic. */
function quotesAt(price: () => number) {
  const client = { request: async (_path: string, params: Record<string, string>) => {
    const out = String(Math.max(1, Math.round(Number(params.amount) / price())))
    return { inputMint: params.inputMint, outputMint: params.outputMint, inAmount: params.amount,
      outAmount: out, otherAmountThreshold: out, slippageBps: Number(params.slippageBps), swapMode: 'ExactIn',
      routePlan: [{ swapInfo: { label: 'Jupiter' } }] }
  } } as unknown as JupiterClient
  return new JupiterQuoteService(client)
}

function serviceAt(price: () => number, orders: MemoryStore<RWAOrder>, cached = new MemoryStore<SavedRWA>()) {
  const registry = registryWith([nvdax])
  return new RWAService(registry, { quotes: quotesAt(price), orders: new RWAConditionalOrders(orders), cached,
    resolver: new AssetResolver(registry, nftEvidence),
    mandate: async () => ({ active: true, remainingLamports: 5_000_000_000n, allowedCategory: 'RWA' }) })
}

test('"100 USDC NVDAx khi giá dưới $175" spends 100 USDC and sets a 175 USD ceiling', () => {
  const intent = parseRWAIntent('Mua 100 USDC NVDAx khi giá dưới $175', [nvdax])
  assert.equal(intent.order, 'SPEND')
  assert.equal(intent.amount, '100000000')
  assert.equal(intent.currency, 'USDC')
  assert.equal(intent.quantity, undefined)
  assert.deepEqual(intent.condition, { type: 'PRICE_BELOW', targetPrice: 175, priceCurrency: 'USD' })
  assert.equal(intent.action, 'BUY')
})

test('"1 NVDAx dưới 1 SOL" buys exactly 1 unit with a 1 SOL cost ceiling', () => {
  const intent = parseRWAIntent('Mua 1 NVDAx dưới 1 SOL', [nvdax])
  assert.equal(intent.order, 'QUANTITY')
  assert.equal(intent.quantity, '1')
  assert.equal(intent.maxTotalSpend, '1000000000')
  assert.equal(intent.maxSpendCurrency, 'SOL')
  assert.equal(intent.condition, undefined)
  assert.equal(intent.action, 'BUY')
})

test('the English phrasing parses as the same conditional RWA buy', () => {
  const intent = parseRWAIntent('Buy $100 of NVDAx when price is below $175', [nvdax])
  assert.equal(intent.order, 'SPEND')
  assert.equal(intent.amount, '100000000')
  assert.equal(intent.currency, 'USDC')
  assert.equal(intent.condition?.targetPrice, 175)
  assert.equal(intent.action, 'BUY')
})

test('an exact approved mint classifies as RWA and unapproved look-alikes block', () => {
  const approved = registryWith([nvdax])
  assert.equal(new AssetResolver(approved, nftEvidence).resolve('Mua 100 USDC NVDAx khi giá dưới $175').assetType, 'RWA')
  // Same symbol, listed but not approved: a counterfeit, which must BLOCK and never become an NFT.
  const listed = registryWith([{ ...nvdax, verified: false }])
  const counterfeit = new AssetResolver(listed, nftEvidence).resolve('Mua 100 USDC NVDAx khi giá dưới $175')
  assert.equal(counterfeit.assetType, 'RWA')
  assert.equal(counterfeit.blocked, true)
  assert.equal(counterfeit.reason, 'symbol_not_approved')
  // An empty registry is an operator gap, not a judgement about the asset, so it says so.
  const empty = registryWith([])
  const blocked = new AssetResolver(empty, nftEvidence).resolve('Mua 100 USDC NVDAx khi giá dưới $175')
  assert.equal(blocked.assetType, 'RWA')
  assert.equal(blocked.blocked, true)
  assert.equal(blocked.reason, 'registry_empty')
})

test('NFT requests stay NFT', () => {
  const resolver = new AssetResolver(registryWith([nvdax]), nftEvidence)
  const plain = resolver.resolve('Mua NFT dưới 1 SOL')
  assert.equal(plain.assetType, 'NFT')
  const named = resolver.resolve('Tìm Bodega Monke dưới 1 SOL')
  assert.equal(named.assetType, 'NFT')
  assert.equal(named.reason, 'nft_discovery')
})

test('a price above the target waits and creates no transaction', async () => {
  const orders = new MemoryStore<RWAOrder>()
  const reply = await serviceAt(() => 180, orders).discover('user-1', 'Mua 100 USDC NVDAx khi giá dưới $175', OWNER)
  assert.equal(reply.status, 'WAITING_FOR_PRICE')
  assert.equal(reply.order?.status, 'WAITING_FOR_PRICE')
  assert.equal(reply.order?.observation?.observedPrice !== null, true)
  assert.equal((reply.order?.observation?.observedPrice ?? 0) < 175, false)
  assert.equal(reply.transaction, undefined)
  assert.equal(reply.signature, undefined)
  assert.equal(reply.order?.execution, undefined)
})

test('an eligible price is revalidated and never reported as confirmed', async () => {
  const orders = new MemoryStore<RWAOrder>()
  const reply = await serviceAt(() => 174.9, orders).discover('user-1', 'Mua 100 USDC NVDAx khi giá dưới $175', OWNER)
  assert.equal(reply.order?.status, 'EXECUTION_UNAVAILABLE')
  assert.notEqual(reply.order?.status, 'CONFIRMED')
  assert.match(reply.order?.execution?.reason ?? '', /^ANCHOR_JUPITER_EXECUTION_REQUIRED/)
  assert.equal(reply.order?.execution?.signature, null)
  assert.equal(reply.signature, undefined)
})

test('the same conditional order is never created twice', async () => {
  const orders = new MemoryStore<RWAOrder>()
  const service = serviceAt(() => 180, orders)
  const first = await service.discover('user-1', 'Mua 100 USDC NVDAx khi giá dưới $175', OWNER)
  const second = await service.discover('user-1', 'Mua 100 USDC NVDAx khi giá dưới $175', OWNER)
  assert.equal(second.order?.id, first.order?.id)
  assert.equal(orders.count, 1)
})

test('a stored quantity is converted with the resolved mint decimals', () => {
  assert.equal(quantityUnits('1', 6), '1000000')
  assert.equal(quantityUnits('0.5', 8), '50000000')
  assert.throws(() => quantityUnits('0.0000001', 6), /tối đa 6 chữ số thập phân/)
})
