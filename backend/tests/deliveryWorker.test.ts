import assert from 'node:assert/strict'
import { test } from 'node:test'
import { startDeliveryWorker } from '../src/services/delivery/DeliveryWorker.js'
import type { DeliveryPlan } from '../src/services/delivery/DeliveryService.js'
import { MemoryDeliveryLease, MongoDeliveryLease } from '../src/services/delivery/DeliveryLease.js'
import type { DatabaseProvider } from '../src/persistence/mongo.js'

test('worker processes due persisted plans and graceful shutdown waits for active delivery', async () => {
  const plan = { id: 'paid', paymentSignature: 'original-payment' } as DeliveryPlan
  let release!: () => void, started!: () => void
  const began = new Promise<void>(resolve => { started = resolve })
  const blocked = new Promise<void>(resolve => { release = resolve })
  let deliveries = 0
  const stop = startDeliveryWorker({ due: async () => [{ userId: 'owner', value: plan }], deliver: async (user, saved) => {
    assert.equal(user, 'owner'); assert.equal(saved.paymentSignature, 'original-payment')
    deliveries++; started(); await blocked
  } }, 10, 0)
  const keepAlive = setTimeout(() => {}, 1000)
  await began
  let stopped = false
  const stopping = stop().then(() => { stopped = true })
  await Promise.resolve(); assert.equal(stopped, false)
  release(); await stopping
  assert.equal(deliveries, 1); clearTimeout(keepAlive)
})
test('manual recovery and worker cannot hold the same order lease concurrently', async () => {
  const leases = new MemoryDeliveryLease()
  const first = await leases.acquire('user', 'NFT:order')
  assert.ok(first)
  assert.equal(await leases.acquire('user', 'NFT:order'), undefined)
  assert.ok(await leases.acquire('other-user', 'NFT:order'))
  await first.release()
  assert.ok(await leases.acquire('user', 'NFT:order'))
})

test('Mongo leases use atomic expiry and fencing so crashed workers cannot release replacement leases', async () => {
  let lease: { token: string; until: Date } | undefined
  const collection = {
    findOneAndUpdate: async (filter: any, update: any) => {
      assert.ok(filter._id); assert.ok(filter.userId)
      if (lease && lease.until > filter.$or[0]['lease.until'].$lte) return null
      lease = update.$set.lease
      return { lease }
    },
    updateOne: async (filter: any, update: any) => {
      if (!lease || lease.token !== filter['lease.token'] || (filter['lease.until'] && lease.until <= filter['lease.until'].$gt)) return { matchedCount: 0 }
      if (update.$unset) lease = undefined
      else lease.until = update.$set['lease.until']
      return { matchedCount: 1 }
    },
  }
  const database = (async () => ({ collection: () => collection })) as unknown as DatabaseProvider
  const firstWorker = new MongoDeliveryLease(database), secondWorker = new MongoDeliveryLease(database)
  const first = await firstWorker.acquire('user', 'NFT:paid')
  assert.ok(first)
  assert.equal(await secondWorker.acquire('user', 'NFT:paid'), undefined)
  lease!.until = new Date(0) // Simulated process crash: heartbeat no longer renews the lease.
  const replacement = await secondWorker.acquire('user', 'NFT:paid')
  assert.ok(replacement)
  await assert.rejects(first.check(), /LEASE_LOST/)
  await first.release()
  await replacement.check()
  await replacement.release()
  assert.equal(lease, undefined)
})
