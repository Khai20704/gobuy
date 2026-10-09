import assert from 'node:assert/strict'
import { test } from 'node:test'
import { recoverAutonomousDeliveryQueue } from '../src/services/delivery/AutonomousDeliveryQueue.js'
import type { DatabaseProvider } from '../src/persistence/mongo.js'
import type { AutonomousPurchaseResult } from '@gobuy/shared'

test('payment outbox recovers after crash before enqueue; uncertain payment is only reconciled', async () => {
  const payment = { id: 'order', selected: { name: 'Provider selected NFT', mint: 'source' }, requestedSpendLamports: '40000000', actualSpendLamports: '40000000', result: { status: 'CONFIRMED', signature: 'paid' } } as AutonomousPurchaseResult
  const updates: any[] = [], queued: any[] = []
  let confirmed = false
  const database = (async () => ({ collection: () => ({
    find: (query: any) => {
      assert.equal(query['value.deliveryMode'], 'DEVNET_DEMO_MINT', 'legacy orders excluded')
      return { limit: () => ({ toArray: async () => [{ _id: 'row', userId: 'user', value: {
        owner: 'phantom', recipientWallet: 'phantom', recipientVerifiedAt: new Date().toISOString(),
        deliveryMode: 'DEVNET_DEMO_MINT', reply: { ...payment, result: { status: 'PENDING' } },
      } }] }) }
    }, updateOne: async (_filter: unknown, update: unknown) => { updates.push(update) },
  }) })) as unknown as DatabaseProvider
  const purchases = { status: async () => confirmed ? payment : { ...payment, result: { ...payment.result, status: 'PENDING' as const } } }
  const delivery = { enqueue: async (_user: string, input: any) => { queued.push(input); return {} as any } }
  await recoverAutonomousDeliveryQueue(database, purchases, delivery)
  assert.equal(queued.length, 0); assert.ok(updates[0].$set.queueRetryAt instanceof Date)
  confirmed = true
  await recoverAutonomousDeliveryQueue(database, purchases, delivery)
  assert.equal(queued.length, 1); assert.equal(queued[0].recipientWallet, 'phantom')
  assert.equal(queued[0].paymentSignature, 'paid'); assert.equal(queued[0].mode, 'DEVNET_DEMO_MINT')
  assert.equal(updates.at(-1).$set.deliveryQueued, true)
})
