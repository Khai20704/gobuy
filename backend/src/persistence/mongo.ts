import { MongoClient, type Db } from 'mongodb'
import { diagnoseMongoFailure } from './mongoDiagnostics.js'

export type DatabaseProvider = () => Promise<Db>
export class MongoUnavailableError extends Error {
  constructor() {
    super('MongoDB initialization failed; check backend configuration, database permissions and network access')
    this.name = 'MongoUnavailableError'
  }
}
export function storageMode(env: NodeJS.ProcessEnv = process.env): 'mongo' | 'file' {
  const mode = env.APP_STORAGE || 'mongo'
  if (mode !== 'mongo' && mode !== 'file') throw new Error('APP_STORAGE must be mongo or file')
  if (mode === 'file' && env.NODE_ENV === 'production') throw new Error('File persistence is restricted to development/tests')
  return mode
}

export async function ensureIndexes(db: Db) {
  await db.collection('RWA_APPROVED_LIST').createIndex({ mint: 1 }, { unique: true })
  await db.collection('users').createIndex({ firebaseUid: 1 }, { unique: true })
  // Current order queries use the public quote ID; no order listing endpoint exists yet.
  await db.collection('orders').createIndex({ orderId: 1 }, { unique: true })
  await db.collection('commerceTwins').createIndex({ session: 1 }, { unique: true })
  await db.collection('naRequests').createIndex({ id: 1 }, { unique: true })
  await db.collection('naRequests').createIndex({ ownerUid: 1, createdAt: -1 })
  for (const name of ['walletAssociations', 'walletChallenges', 'assetPositions', 'assetDiscoveries', 'assetAcquisitions', 'naConversations',
    'spendingPolicies', 'spendingPolicyChallenges', 'authorizationLogs', 'rwaTransactions', 'rwaSubmissions']) {
    await db.collection(name).createIndex({ userId: 1 })
  }
  await db.collection('nftMarketSnapshots').createIndex({ 'value.features.collection': 1, 'value.features.observedAt': -1 })
  await db.collection('nftMarketSnapshots').createIndex({ 'value.features.mint': 1, 'value.features.observedAt': -1 })
  await db.collection('nftMarketSnapshots').createIndex({ 'value.features.observedAt': 1 })
  await db.collection('nftPredictions').createIndex({ 'value.mint': 1, 'value.observedAt': -1 })
  await db.collection('nftPredictions').createIndex({ 'value.observedAt': 1 })
  await db.collection('nftPredictionResults').createIndex({ 'value.predictionId': 1, 'value.horizon': 1 }, { unique: true })
  await db.collection('nftPredictionResults').createIndex({ 'value.observedAt': 1 })
}

export class MongoDatabase {
  private client?: MongoClient
  private pending?: Promise<Db>
  constructor(private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly factory = (uri: string) => new MongoClient(uri, { maxPoolSize: 10, serverSelectionTimeoutMS: 8000 })) {}
  get: DatabaseProvider = () => {
    if (!this.pending) this.pending = this.connect().catch(error => { this.pending = undefined; throw error })
    return this.pending
  }
  private async connect() {
    if (!this.env.MONGODB_URI?.trim()) throw new Error('MONGODB_URI is required for Mongo persistence')
    const name = this.env.MONGODB_DB_NAME || 'gobuy'
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) throw new Error('Invalid MONGODB_DB_NAME')
    if (this.env.FIREBASE_AUTH_EMULATOR_HOST && !name.endsWith('_emulator')) throw new Error('Auth emulator requires a separate MONGODB_DB_NAME ending in _emulator')
    let stage = 'connect'
    try {
      this.client = this.factory(this.env.MONGODB_URI)
      await this.client.connect()
      const db = this.client.db(name)
      stage = 'indexes'
      await ensureIndexes(db)
      console.log('MongoDB application database initialized')
      return db
    } catch (error) {
      console.error('[MongoDB]', JSON.stringify({ stage, ...diagnoseMongoFailure(error) }))
      await this.client?.close().catch(() => {})
      this.client = undefined
      throw new MongoUnavailableError()
    }
  }
  async close() {
    await this.pending?.catch(() => {})
    await this.client?.close()
    this.client = undefined; this.pending = undefined
  }
}
export const mongoDatabase = new MongoDatabase()
