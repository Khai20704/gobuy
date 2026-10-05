import { shippingAddressSchema, type ShippingAddress } from '@gobuy/shared'
import type { Identity, ProfileStore } from '../auth/accounts.js'
import { mongoDatabase, type DatabaseProvider } from './mongo.js'

export type UserDocument = { firebaseUid: string; email?: string | null; phone?: string | null;
  address?: ShippingAddress; createdAt: Date; updatedAt: Date }
export class MongoProfileStore implements ProfileStore {
  constructor(private readonly database: DatabaseProvider = mongoDatabase.get) {}
  private async users() { return (await this.database()).collection<UserDocument>('users') }
  async read(uid: string) {
    const user = await (await this.users()).findOne({ firebaseUid: uid })
    return user?.address ? shippingAddressSchema.parse(user.address) : null
  }
  async syncIdentity(identity: Identity) {
    const now = new Date()
    await (await this.users()).updateOne({ firebaseUid: identity.uid }, {
      $set: { email: identity.email, phone: identity.phone, updatedAt: now },
      $setOnInsert: { firebaseUid: identity.uid, createdAt: now },
    }, { upsert: true })
  }
  async save(uid: string, address: ShippingAddress) {
    const now = new Date()
    await (await this.users()).updateOne({ firebaseUid: uid }, {
      $set: { address: shippingAddressSchema.parse(address), updatedAt: now },
      $setOnInsert: { firebaseUid: uid, createdAt: now },
    }, { upsert: true })
  }
}
