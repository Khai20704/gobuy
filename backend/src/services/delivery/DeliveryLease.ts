import { createHash, randomUUID } from 'node:crypto'
import { mongoDatabase, type DatabaseProvider } from '../../persistence/mongo.js'
import type { DeliveryPlan } from './DeliveryService.js'
import type { DevnetDelivery } from '@gobuy/shared'

export interface DeliveryLease {
  acquire(user: string, key: string): Promise<{ check(): Promise<void>; release(recovery?: DevnetDelivery['recovery']): Promise<void> } | undefined>
}
/** Development/test fallback. Production uses the same persisted plan document as a lease. */
export class MemoryDeliveryLease implements DeliveryLease {
  private readonly keys = new Set<string>()
  async acquire(user: string, key: string) {
    const id = JSON.stringify([user, key])
    if (this.keys.has(id)) return undefined
    this.keys.add(id)
    return { check: async () => {}, release: async () => { this.keys.delete(id) } }
  }
}
export const memoryDeliveryLease = new MemoryDeliveryLease()
type PlanDocument = { _id: string; userId: string; value: DeliveryPlan; lease?: { token: string; until: Date }; recovery?: DevnetDelivery['recovery'] }
export class MongoDeliveryLease implements DeliveryLease {
  constructor(private readonly database: DatabaseProvider = mongoDatabase.get) {}
  private async collection() { return (await this.database()).collection<PlanDocument>('deliveryPlans') }
  async acquire(userId: string, key: string) {
    const collection = await this.collection(), token = randomUUID()
    const _id = createHash('sha256').update(userId + ':' + key).digest('hex')
    const duration = 120000
    const row = await collection.findOneAndUpdate({ _id, userId, $or: [{ 'lease.until': { $lte: new Date() } }, { lease: { $exists: false } }] },
      { $set: { lease: { token, until: new Date(Date.now() + duration) } } }, { returnDocument: 'after' })
    if (!row) return undefined
    let lost = false
    const check = async () => {
      if (lost) throw new Error('DELIVERY_LEASE_LOST')
      const result = await collection.updateOne({ _id, 'lease.token': token, 'lease.until': { $gt: new Date() } },
        { $set: { 'lease.until': new Date(Date.now() + duration) } })
      if (!result.matchedCount) { lost = true; throw new Error('DELIVERY_LEASE_LOST') }
    }
    const heartbeat = setInterval(() => { void check().catch(() => { lost = true }) }, 30000)
    heartbeat.unref()
    return { check, release: async (recovery?: DevnetDelivery['recovery']) => {
      clearInterval(heartbeat)
      await collection.updateOne({ _id, 'lease.token': token }, { $unset: { lease: '' }, ...(recovery ? { $set: { recovery } } : {}) })
    } }
  }
  async due() {
    const now = new Date()
    return (await this.collection()).find({
      'recovery.status': { $nin: ['completed', 'requires_attention'] },
      $and: [
        { $or: [{ 'recovery.nextRetryAt': { $lte: now.toISOString() } }, { 'recovery.nextRetryAt': { $exists: false } }] },
        { $or: [{ 'lease.until': { $lte: now } }, { lease: { $exists: false } }] },
      ],
    }).sort({ 'recovery.nextRetryAt': 1 }).limit(20).toArray()
  }
}
