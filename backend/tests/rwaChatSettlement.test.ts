import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { rwaIntentSchema, rwaReplySchema, type RWAAsset, type RWAReply, type MandateSpendResponse } from '@gobuy/shared'
import { BSON } from 'mongodb'
import type { AssetStore } from '../src/persistence/AssetStore.js'
import { RWAChatSettlement, type RWAChatPlan } from '../src/services/rwa/RWAChatSettlement.js'
import { RWARegistry } from '../src/services/rwa/RWARegistry.js'
import { JupiterQuoteService } from '../src/services/jupiter/JupiterQuoteService.js'
import { SOL_MINT, USDC_MINT } from '../src/services/jupiter/types.js'
import { parseRWAIntent } from '../src/services/rwa/RWAIntent.js'
import type { VaultSpendRequest } from '../src/services/mandate/autonomousSpend.js'
import { decimalUnits } from '../src/services/delivery/quantity.js'
import type { DeliveryInput } from '../src/services/delivery/DeliveryService.js'

const asset: RWAAsset = { mint: SOL_MINT, symbol: 'NVDAx', name: 'NVIDIA xStock', issuer: 'fixture',
  underlying: 'NVDA', category: 'EQUITY', decimals: 6, verified: true, allowedForSwap: true,
  updatedAt: new Date().toISOString(), verificationSource: 'https://example.com' }
function setup() {
  const rows = new Map<string, RWAChatPlan>()
  const store = { get: async (_u: string, id: string) => rows.get(id),
    put: async (_u: string, id: string, value: RWAChatPlan, once?: boolean) => { if (!once || !rows.has(id)) rows.set(id, value) } } as AssetStore<RWAChatPlan>
  const registry = new RWARegistry([asset])
  let status: 'PENDING' | 'CONFIRMED' | 'FAILED' = 'CONFIRMED'
  let mandate = 'mandate:1'
  const spends: VaultSpendRequest[] = [], conversions: string[] = []
  const deliveries: DeliveryInput[] = []
  let deliveryPhase: 'COMPLETED' | 'DELIVERY_FAILED' = 'COMPLETED'
  const reply: RWAReply = { id: randomUUID(), status: 'RECOMMENDED', message: 'recommend', warnings: [],
    recommendations: [{ mint: asset.mint, name: asset.name, symbol: asset.symbol, category: 'EQUITY',
      priceUsd: 150, withinBudget: true, estimatedQuantity: '0.666', score: 80, reasons: [] }] }
  const quotes = { quote: async (input: string, output: string, amount: string) => {
    if (input === SOL_MINT && output === USDC_MINT) return { outAmount: '40000000' }
    assert.equal(input, USDC_MINT); assert.equal(output, SOL_MINT); conversions.push(amount)
    return { outAmount: '500000000' }
  } } as JupiterQuoteService
  const service = new RWAChatSettlement(registry, { discover: async () => reply }, async request => {
    spends.push(request)
    return { status, message: 'settlement', signature: 'signature' } as MandateSpendResponse
  }, async () => mandate, quotes, store, { deliver: async (_user, input) => {
    deliveries.push(input)
    return { ...input, quantity: decimalUnits(input.rawQuantity, input.decimals), network: 'devnet', simulated: true,
      phase: deliveryPhase, ownership: 'verified', message: 'Không có RWA thật; token demo delivered', mint: SOL_MINT, signature: 'delivery-signature' }
  } })
  return { service, registry, reply, rows, spends, conversions, deliveries, setDeliveryPhase: (value: typeof deliveryPhase) => { deliveryPhase = value }, setMandate: (value: string) => { mandate = value }, setStatus: (value: typeof status) => { status = value },
    input: { requestId: randomUUID(), owner: 'owner', text: 'Tìm cho tui RWA công nghệ khoảng 100USD' } }
}

test('USD budget preserves payment and delivers fractional RWA tokens from validated price', async () => {
  const f = setup()
  assert.equal(parseRWAIntent(f.input.text, [asset]).amount, '100000000')
  const result = await f.service.run('user', f.input)
  assert.equal(result.status, 'CONFIRMED'); assert.equal(result.network, 'devnet')
  assert.equal(result.phase, 'COMPLETED'); assert.equal(result.delivery?.quantity, '0.666666')
  assert.match(result.message, /Không có RWA thật/)
  assert.deepEqual(f.conversions, ['100000000'])
  assert.equal(f.spends[0].amountLamports, 500000000n); assert.equal(f.spends[0].category, 'RWA')
  await f.service.run('user', f.input)
  assert.equal(f.spends.length, 1)
})

test('delivery retries use saved price and quantity without another payment or discovery', async () => {
  const f = setup(); f.setDeliveryPhase('DELIVERY_FAILED')
  const failed = await f.service.run('user', f.input)
  assert.equal(failed.status, 'PENDING'); assert.equal(failed.phase, 'DELIVERY_FAILED')
  f.reply.recommendations![0].priceUsd = 1
  f.setMandate('recreated'); f.setDeliveryPhase('COMPLETED')
  const done = await f.service.run('user', f.input)
  assert.equal(done.delivery?.quantity, '0.666666')
  assert.equal(f.spends.length, 1); assert.equal(f.conversions.length, 1)
  assert.deepEqual(f.deliveries[0], f.deliveries[1])
})

test('pending retries retain asset, conversion and spend reference; mismatched owner is refused', async () => {
  const f = setup(); f.setStatus('PENDING')
  await f.service.run('user', f.input)
  f.reply.recommendations = []
  f.setStatus('CONFIRMED'); await f.service.run('user', f.input)
  assert.deepEqual(f.spends[0], f.spends[1]); assert.equal(f.conversions.length, 1)
  await assert.rejects(f.service.run('user', { ...f.input, owner: 'other' }), /không khớp/)
})

test('search-only, no budget, missing route and unapproved selections do not spend', async () => {
  for (const text of ['Chỉ tìm RWA công nghệ khoảng 100 USD', 'Tìm RWA công nghệ']) {
    const f = setup(); await f.service.run('user', { ...f.input, text }); assert.equal(f.spends.length, 0)
  }
  const f = setup(); f.reply.recommendations![0].withinBudget = null
  await f.service.run('user', f.input); assert.equal(f.spends.length, 0)
  f.reply.recommendations![0].withinBudget = true
  f.registry.isApprovedMint = () => false
  await assert.rejects(f.service.run('user', f.input)); assert.equal(f.spends.length, 0)
})

test('SOL budget bypasses conversion and failed mandate settlement never reports success', async () => {
  const f = setup(); f.setStatus('FAILED')
  const reply = await f.service.run('user', { ...f.input, text: 'Tìm RWA công nghệ khoảng 0.2 SOL' })
  assert.equal(reply.status, 'FAILED'); assert.equal(f.conversions.length, 0)
  assert.equal(f.spends[0].amountLamports, 200000000n)
})

test('pending request cannot be retried against a recreated mandate', async () => {
  const f = setup(); f.setStatus('PENDING')
  await f.service.run('user', f.input)
  f.setMandate('mandate:2')
  await assert.rejects(f.service.run('user', f.input), /Mandate đã thay đổi/)
  assert.equal(f.spends.length, 1)
})

test('concurrent requests use the same immutable on-chain spend identity', async () => {
  const f = setup(); f.setStatus('PENDING')
  await Promise.all([f.service.run('user', f.input), f.service.run('user', f.input)])
  assert.deepEqual(f.spends[0], f.spends[1])
})

test('BSON legacy null optional intent fields normalize on pending and completed retries without another spend', async () => {
  const f = setup(); f.setStatus('PENDING')
  const intent = parseRWAIntent('mua cho tôi một RWA công nghệ đáng mua trong khoảng 100 USDC', [asset])
  const legacy = BSON.deserialize(BSON.serialize({ ...intent, subtype: undefined, symbol: undefined,
    mint: undefined, quantity: undefined, condition: undefined, maxTotalSpend: undefined, maxSpendCurrency: undefined }, { ignoreUndefined: false }))
  assert.equal(legacy.symbol, null)
  f.reply.intent = legacy as typeof intent
  await f.service.run('user', f.input)
  f.setStatus('CONFIRMED')
  const result = await f.service.run('user', f.input)
  assert.doesNotThrow(() => rwaReplySchema.parse(result))
  assert.equal(Object.hasOwn(result.intent!, 'symbol'), false)
  const stored = f.rows.get(f.input.requestId)!
  stored.result!.intent = legacy as typeof intent
  const retry = await f.service.run('user', f.input)
  assert.doesNotThrow(() => rwaReplySchema.parse(retry))
  assert.equal(Object.hasOwn(retry.intent!, 'subtype'), false)
  assert.equal(f.spends.length, 2)
})

test('intent normalization preserves validation of required and invalid non-null fields', () => {
  const intent = parseRWAIntent('Tìm RWA công nghệ khoảng 100 USDC', [asset])
  assert.equal(Object.values(intent).some(value => value === undefined), false)
  assert.equal(rwaIntentSchema.safeParse({ ...intent, currency: null }).success, false)
  assert.equal(rwaIntentSchema.safeParse({ ...intent, subtype: 'TECHNOLOGY' }).success, false)
  assert.equal(rwaIntentSchema.safeParse({ ...intent, symbol: 123 }).success, false)
})
