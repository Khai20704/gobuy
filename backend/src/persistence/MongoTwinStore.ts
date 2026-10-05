import { storedSchema, type StoredTwin, type TwinStore } from '../services/twin/TwinStore.js'
import { mongoDatabase, type DatabaseProvider } from './mongo.js'

type TwinDocument = { session: string; value: StoredTwin; revision: number }
export class MongoTwinStore implements TwinStore {
  constructor(private readonly database: DatabaseProvider = mongoDatabase.get) {}
  private async collection(session: string) {
    if (!/^[a-f0-9]{64}$/.test(session)) throw new Error('Invalid session storage key')
    return (await this.database()).collection<TwinDocument>('commerceTwins')
  }
  async read(session: string) {
    const row = await (await this.collection(session)).findOne({ session })
    return storedSchema.parse(row?.value ?? { explicit: {}, history: [], actions: [] })
  }
  async update(session: string, change: (value: StoredTwin) => StoredTwin) {
    const collection = await this.collection(session)
    // Optimistic concurrency preserves append/update operations across backend instances.
    for (let attempt = 0; attempt < 10; attempt++) {
      const row = await collection.findOne({ session })
      const value = storedSchema.parse(change(storedSchema.parse(row?.value ?? { explicit: {}, history: [], actions: [] })))
      if (!row) {
        try { await collection.insertOne({ session, value, revision: 0 }); return value }
        catch (error) { if ((error as { code?: number }).code === 11000) continue; throw error }
      }
      const result = await collection.updateOne({ session, revision: row.revision }, { $set: { value }, $inc: { revision: 1 } })
      if (result.modifiedCount) return value
    }
    throw new Error('Commerce Twin update conflicted; retry request')
  }
}
