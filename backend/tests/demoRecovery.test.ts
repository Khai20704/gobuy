import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createPrivateKey, sign } from 'node:crypto'
import { Keypair } from '@solana/web3.js'
import { DemoRecovery } from '../src/services/delivery/DemoRecovery.js'
import { DeliveryService, type DeliveryPlan, type DeliveryChain } from '../src/services/delivery/DeliveryService.js'
import { MemoryDeliveryLease } from '../src/services/delivery/DeliveryLease.js'
import type { AssetStore } from '../src/persistence/AssetStore.js'
import { verifyPublicMetadata } from '../src/services/delivery/metadataUrl.js'

function memory<T>(): AssetStore<T> {
  const rows = new Map<string, T>()
  return { get: async (u, id) => structuredClone(rows.get(u + ':' + id)), put: async (u, id, value, once) => {
    if (!once || !rows.has(u + ':' + id)) rows.set(u + ':' + id, structuredClone(value))
  }, list: async () => [...rows.values()], take: async (u, id) => { const row = rows.get(u + ':' + id); rows.delete(u + ':' + id); return row } }
}
test('signed replacement consent binds account, order, payment and wallet; retries never broadcast or repay', async () => {
  const wallet = Keypair.generate(), owner = wallet.publicKey.toBase58()
  const plan: DeliveryPlan = { id: 'order', owner, kind: 'NFT', mode: 'TRANSFER_NFT', name: 'Reference', sourceMint: 'source',
    rawQuantity: '1', decimals: 0, paymentSignature: 'payment', metadataId: 'a'.repeat(64) }
  const plans = memory<DeliveryPlan>(), attempts = memory<any>(), completions = memory<any>()
  await plans.put('alice', 'NFT:order', plan)
  let broadcasts = 0, checks = 0
  const challenges = memory<any>()
  const chain: DeliveryChain = { prepare: async () => { throw new Error('must not prepare during consent') }, inspect: async () => 'pending',
    send: async () => { broadcasts++ }, holdings: async () => ({ ownership: 'unknown', balance: '0' }), assertNoExistingMint: async () => {} }
  const delivery = new DeliveryService(chain, plans, attempts, completions, memory(), memory(), memory(), new MemoryDeliveryLease(), Date.now,
    async (user, _previous, converted) => {
      assert.ok(await challenges.take(user, 'demo:' + converted.recoveryConsent!.challengeId))
      await plans.put(user, 'NFT:order', converted)
    })
  const order = { owner, recoveryReview: { status: 'unsettled', paymentSignature: 'payment', reviewedBy: 'operator', reviewedAt: new Date().toISOString() },
    reply: { result: { status: 'CONFIRMED', signature: 'payment' } } }
  const recovery = new DemoRecovery({ existing: async (u: string) => u === 'alice' ? order : undefined } as any,
    { require: async (_u: string, address: string) => { assert.equal(address, owner) } } as any, delivery, challenges, async () => { checks++ })
  await assert.rejects(recovery.challenge('bob', 'order', owner), /purchaser/)
  await assert.rejects(recovery.challenge('alice', 'order', Keypair.generate().publicKey.toBase58()), /purchaser/)
  const challenge = await recovery.challenge('alice', 'order', owner)
  assert.match(challenge.message, /Delivery mode: DEVNET_DEMO_MINT/)
  await assert.rejects(recovery.accept('alice', 'other-order', challenge.id, ''), /invalid/)
  await challenges.put('alice', 'demo:expired', { ...challenge, id: 'expired', expiresAt: new Date(0).toISOString() })
  await assert.rejects(recovery.accept('alice', 'order', 'expired', ''), /expired/)
  assert.equal((await delivery.getPlan('alice', 'order'))?.mode, 'TRANSFER_NFT')
  const review = order.recoveryReview
  order.recoveryReview = undefined as any
  await assert.rejects(recovery.challenge('alice', 'order', owner), /operator review/)
  order.recoveryReview = review
  ;(order as any).refundSignature = 'refund'
  await assert.rejects(recovery.challenge('alice', 'order', owner), /refunded/)
  delete (order as any).refundSignature
  await assert.rejects(recovery.accept('alice', 'order', challenge.id, Buffer.alloc(64).toString('base64')), /signature/)
  const key = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(wallet.secretKey.slice(0, 32))]), format: 'der', type: 'pkcs8' })
  const signature = sign(null, Buffer.from(challenge.message), key).toString('base64')
  const accepted = await recovery.accept('alice', 'order', challenge.id, signature)
  assert.equal(accepted.mode, 'DEVNET_DEMO_MINT'); assert.equal(accepted.recipientWallet, owner)
  assert.equal(accepted.paymentSignature, 'payment')
  await assert.rejects(recovery.accept('alice', 'order', challenge.id, signature), /invalid/)
  assert.equal(checks, 2); assert.equal(broadcasts, 0)
  // Existing attempt, even if apparently failed, prevents conversion of another legacy plan.
  await plans.put('alice', 'NFT:order', plan)
  const retry = await recovery.challenge('alice', 'order', owner)
  const retrySignature = sign(null, Buffer.from(retry.message), key).toString('base64')
  await attempts.put('alice', 'NFT:order:0', { signature: 'uncertain' })
  await assert.rejects(recovery.accept('alice', 'order', retry.id, retrySignature), /signed delivery/)
  assert.equal((await delivery.getPlan('alice', 'order'))?.mode, 'TRANSFER_NFT')
  await completions.put('alice', 'NFT:order', { attempt: { signature: 'done' } })
  await assert.rejects(recovery.accept('alice', 'order', retry.id, retrySignature), /already completed/)
})
test('metadata check requires accessible matching JSON and image', async () => {
  const expected = { name: 'Demo', image: 'https://public.example/demo.svg' }
  await verifyPublicMetadata('https://public.example/meta', expected, async url => String(url).endsWith('.svg')
    ? new Response('<svg/>', { headers: { 'content-type': 'image/svg+xml' } })
    : Response.json({ ...expected, symbol: 'DEMO-NFT', description: 'Simulation', attributes: [{ value: 'Demo / Simulated NFT' }] }))
  await assert.rejects(verifyPublicMetadata('https://public.example/meta', expected, async () => new Response('', { status: 404 })), /unavailable/)
  await assert.rejects(verifyPublicMetadata('https://public.example/meta', expected, async () => Response.json({ name: 'wrong' })), /mismatch/)
})
