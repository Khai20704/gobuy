import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { AssetStore } from '../src/persistence/AssetStore.js'
import { DeliveryService, type DeliveryChain, type DeliveryInput, type DeliveryAttempt } from '../src/services/delivery/DeliveryService.js'
import { deliveryUnits, decimalUnits } from '../src/services/delivery/quantity.js'
import { MemoryDeliveryLease } from '../src/services/delivery/DeliveryLease.js'

function memory<T>(): AssetStore<T> {
  const rows = new Map<string, T>()
  return { get: async (u, id) => structuredClone(rows.get(u + id)), put: async (u, id, value, once) => {
    if (!once || !rows.has(u + id)) rows.set(u + id, structuredClone(value))
  }, list: async u => [...rows].filter(([key]) => key.startsWith(u)).map(([, value]) => structuredClone(value)),
  take: async (u, id) => { const row = rows.get(u + id); rows.delete(u + id); return row } }
}
const input: DeliveryInput = { id: 'purchase', owner: 'recipient', kind: 'RWA', name: 'NVDAx', sourceMint: 'original',
  mode: 'RWA_TOKEN', rawQuantity: '666666', decimals: 6, paymentSignature: 'payment-signature' }
function fixture() {
  let prepared = 0, holding = true, networkFailure = false, failureMessage = 'RPC unavailable'
  const sent: string[] = [], states = new Map<string, Awaited<ReturnType<DeliveryChain['inspect']>>>()
  const chain: DeliveryChain = {
    prepare: async () => ({ mint: 'mint', signature: `signature-${++prepared}`, wire: 'signed', lastValidBlockHeight: 10, standard: 'spl' }),
    inspect: async (_p, a) => { if (networkFailure) throw new Error(failureMessage); return states.get(a.signature) ?? 'pending' },
    send: async a => { sent.push(a.signature); if (networkFailure) throw new Error('RPC unavailable') },
    holdings: async () => { if (networkFailure) throw new Error('RPC unavailable'); return { ownership: holding ? 'verified' : 'not_owned', balance: holding ? '0.666666' : '0' } },
  }
  const plans = memory<any>(), attempts = memory<DeliveryAttempt>(), completions = memory<any>(), events = memory<any>(), metadata = memory<Record<string, unknown>>()
  const views = memory<any>()
  let now = Date.now()
  const leases = new MemoryDeliveryLease()
  const create = () => new DeliveryService(chain, plans, attempts, completions, events, metadata, views, leases, () => now)
  return { service: create(), create, states, sent, get prepared() { return prepared },
    move: () => { holding = false }, fail: (message = 'RPC unavailable') => { networkFailure = true; failureMessage = message },
    recover: () => { networkFailure = false }, advance: () => { now += 3600000 } }
}
test('exact fractional quantities floor instead of issuing one token', () => {
  assert.equal(deliveryUnits('100', '150'), '666666')
  assert.equal(deliveryUnits('40', '150'), '266666')
  assert.equal(deliveryUnits('1', '0.000001'), '1000000000000')
  assert.equal(decimalUnits('1234567', 6), '1.234567')
  for (const price of ['0', '-1', 'NaN', 'Infinity']) assert.throws(() => deliveryUnits('100', price))
  assert.throws(() => deliveryUnits('0.00000001', '1000'))
})
test('pending transaction is reused after restart and completion requires chain evidence', async () => {
  const f = fixture()
  assert.equal((await f.service.deliver('user', input)).phase, 'DELIVERY_PENDING')
  f.advance()
  await f.create().deliver('user', input)
  assert.deepEqual(f.sent, ['signature-1', 'signature-1']); assert.equal(f.prepared, 1)
  f.states.set('signature-1', 'confirmed')
  f.advance()
  assert.equal((await f.service.deliver('user', input)).phase, 'COMPLETED')
  f.move()
  const moved = await f.create().deliver('user', input)
  assert.equal(moved.phase, 'COMPLETED'); assert.equal(moved.ownership, 'not_owned'); assert.equal(f.sent.length, 2)
})
test('concurrent workers only broadcast the winning immutable signed transaction', async () => {
  const f = fixture()
  await Promise.all([f.service.deliver('user', input), f.create().deliver('user', input)])
  assert.equal(new Set(f.sent).size, 1)
  await assert.rejects(f.service.deliver('user', { ...input, owner: 'other' }), /mismatch/)
  await assert.rejects(f.service.deliver('user', { ...input, rawQuantity: '1' }), /mismatch/)
})
test('chain-confirmed failure requires attention without automatically minting again', async () => {
  const f = fixture(); await f.service.deliver('user', input)
  f.states.set('signature-1', 'failed')
  f.advance()
  assert.equal((await f.service.deliver('user', input)).phase, 'DELIVERY_FAILED')
  assert.equal((await f.service.list('user'))[0].phase, 'DELIVERY_FAILED')
  assert.equal((await f.service.deliver('user', input)).recovery?.status, 'requires_attention')
  assert.equal(f.prepared, 1)
})
test('RPC failures never fabricate ownership or completion', async () => {
  const f = fixture(); await f.service.deliver('user', input); f.fail()
  f.advance()
  const reply = await f.service.deliver('user', input)
  assert.equal(reply.phase, 'DELIVERY_PENDING'); assert.equal(reply.ownership, 'unknown')
  assert.equal(f.prepared, 1)
})

test('429 keeps the signed delivery pending and recovery confirms the same transaction', async () => {
  const f = fixture(); await f.service.deliver('user', input)
  f.fail('429 Too Many Requests: {"error":{"code":429}}')
  f.advance()
  const pending = await f.create().deliver('user', input)
  assert.equal(pending.phase, 'DELIVERY_PENDING')
  assert.equal(pending.signature, 'signature-1')
  assert.equal(pending.paymentSignature, input.paymentSignature)
  assert.doesNotMatch(pending.message, /429|jsonrpc/)
  assert.equal((await f.service.list('user'))[0].phase, 'DELIVERY_PENDING')
  f.recover(); f.states.set('signature-1', 'confirmed')
  f.advance()
  assert.equal((await f.create().deliver('user', input)).phase, 'COMPLETED')
  assert.equal(f.prepared, 1)
  assert.deepEqual(f.sent, ['signature-1'])
})

test('manual checks respect persisted retry time and uncertain outcomes never rebroadcast', async () => {
  const f = fixture()
  const initial = await f.service.deliver('user', input)
  await f.create().deliver('user', input)
  assert.equal(f.sent.length, 1)
  assert.ok(initial.recovery?.nextRetryAt)
  f.states.set('signature-1', 'uncertain'); f.advance()
  const pending = await f.create().deliver('user', input)
  assert.equal(pending.recovery?.lastError, 'TRANSACTION_OUTCOME_UNKNOWN')
  assert.equal(f.prepared, 1); assert.equal(f.sent.length, 1)
})

test('safe finalized expiry replaces only the transaction and preserves the mint', async () => {
  const f = fixture(); const first = await f.service.deliver('user', input)
  f.states.set('signature-1', 'retryable'); f.advance()
  const next = await f.create().deliver('user', input)
  assert.equal(first.mint, next.mint); assert.equal(next.signature, 'signature-2')
  assert.equal(next.paymentSignature, input.paymentSignature)
})

 test('Core retries retain immutable plan and signed attempt across restarts, timeouts and 429', async () => {
  const f = fixture(), core: DeliveryInput = { ...input, kind: 'NFT', mode: 'DEVNET_DEMO_MINT', assetStandard: 'METAPLEX_CORE',
    recipientWallet: input.owner, recipientVerifiedAt: new Date().toISOString(), rawQuantity: '1', decimals: 0, metadataUri: 'https://assets.example/metadata.json', imageUri: 'https://assets.example/demo.png' }
  await Promise.all([f.service.deliver('user', core), f.create().deliver('user', core)])
  assert.equal(f.prepared, 1)
  for (const error of ['RPC timeout', '429 Too Many Requests']) {
    f.fail(error); f.advance()
    assert.equal((await f.create().deliver('user', core)).phase, 'DELIVERY_PENDING')
    assert.equal(f.prepared, 1)
  }
  await assert.rejects(f.create().deliver('user', { ...core, assetStandard: 'TOKEN_2022' }), /mismatch/)
  await assert.rejects(f.create().deliver('user', { ...core, imageUri: 'https://other.example/demo.png' }), /mismatch/)
  f.recover(); f.advance(); f.states.set('signature-1', 'confirmed')
  assert.equal((await f.create().deliver('user', core)).phase, 'COMPLETED')
  const count = f.sent.length
  await f.create().deliver('user', core)
  assert.equal(f.sent.length, count); assert.equal(f.prepared, 1)
 })
 test('historical completed Token-2022 plans cannot be converted into Core', async () => {
  const f = fixture(); await f.service.deliver('user', input)
  f.advance(); f.states.set('signature-1', 'confirmed'); await f.service.deliver('user', input)
  const before = await f.service.list('user')
  await assert.rejects(f.create().deliver('user', { ...input, assetStandard: 'METAPLEX_CORE', metadataUri: 'https://assets.example/m.json', imageUri: 'https://assets.example/a.png' }), /mismatch/)
  assert.deepEqual(await f.service.list('user'), before)
  assert.equal(f.prepared, 1)
 })
