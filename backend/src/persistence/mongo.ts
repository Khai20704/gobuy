import { MongoClient, type Db, type ClientSession } from 'mongodb'
import { diagnoseMongoFailure, isDnsResolutionFailure } from './mongoDiagnostics.js'
import { isSrvUri, resolveDirectUri } from './srvResolution.js'

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
  const pending: Promise<unknown>[] = []
  pending.push(db.collection('deliveryPlans').createIndex({ 'recovery.status': 1, 'recovery.nextRetryAt': 1, 'lease.until': 1 }))
  pending.push(db.collection('deliveryPlans').createIndex({ userId: 1 }))
  pending.push(db.collection('RWA_APPROVED_LIST').createIndex({ mint: 1 }, { unique: true }))
  pending.push(db.collection('users').createIndex({ firebaseUid: 1 }, { unique: true }))
  // Current order queries use the public quote ID; no order listing endpoint exists yet.
  pending.push(db.collection('orders').createIndex({ orderId: 1 }, { unique: true }))
  pending.push(db.collection('commerceTwins').createIndex({ session: 1 }, { unique: true }))
  pending.push(db.collection('naRequests').createIndex({ id: 1 }, { unique: true }))
  pending.push(db.collection('naRequests').createIndex({ ownerUid: 1, createdAt: -1 }))
  for (const name of ['walletAssociations', 'walletChallenges', 'assetPositions', 'assetDiscoveries', 'assetAcquisitions', 'naConversations',
    'spendingPolicies', 'spendingPolicyChallenges', 'authorizationLogs', 'rwaTransactions', 'rwaSubmissions']) {
    pending.push(db.collection(name).createIndex({ userId: 1 }))
  }
  pending.push(db.collection('nftMarketSnapshots').createIndex({ 'value.features.collection': 1, 'value.features.observedAt': -1 }))
  pending.push(db.collection('nftMarketSnapshots').createIndex({ 'value.features.mint': 1, 'value.features.observedAt': -1 }))
  pending.push(db.collection('nftMarketSnapshots').createIndex({ 'value.features.observedAt': 1 }))
  pending.push(db.collection('nftPredictions').createIndex({ 'value.mint': 1, 'value.observedAt': -1 }))
  pending.push(db.collection('nftPredictions').createIndex({ 'value.observedAt': 1 }))
  pending.push(db.collection('nftPredictionResults').createIndex({ 'value.predictionId': 1, 'value.horizon': 1 }, { unique: true }))
  pending.push(db.collection('nftPredictionResults').createIndex({ 'value.observedAt': 1 }))
  await Promise.all(pending)
}

interface ConnectionFailure {
  stage: string
  error: unknown
}

export class MongoDatabase {
  private client?: MongoClient
  private pending?: Promise<Db>
  private readonly seedResolver: (uri: string) => Promise<string>
  constructor(private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly factory: (uri: string) => MongoClient = uri => new MongoClient(uri, { maxPoolSize: 10, serverSelectionTimeoutMS: 8000, connectTimeoutMS: 8000, socketTimeoutMS: 20000 }),
    seedResolver?: (uri: string) => Promise<string>) {
    const endpoints = env.MONGODB_SRV_DOH_URL?.split(',').map(value => value.trim()).filter(Boolean)
    this.seedResolver = seedResolver ?? (uri => resolveDirectUri(uri, endpoints?.length ? { endpoints } : {}))
  }
  get: DatabaseProvider = () => {
    if (!this.pending) this.pending = this.connect().catch(error => { this.pending = undefined; throw error })
    return this.pending
  }
  private async connect(): Promise<Db> {
    if (!this.env.MONGODB_URI?.trim()) throw new Error('MONGODB_URI is required for Mongo persistence')
    const name = this.env.MONGODB_DB_NAME?.trim() || 'gobuy'
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) throw new Error('Invalid MONGODB_DB_NAME')
    if (this.env.FIREBASE_AUTH_EMULATOR_HOST && !name.endsWith('_emulator')) throw new Error('Auth emulator requires a separate MONGODB_DB_NAME ending in _emulator')
    const uri = this.env.MONGODB_URI.trim()
    const first = await this.open(uri, name, performance.now())
    if ('db' in first) return first.db
    if (!this.canRetryOverDoh(uri, first.error)) this.fail(first)
    console.warn('[MongoDB]', JSON.stringify({ stage: 'srv-fallback', ...diagnoseMongoFailure(first.error) }))
    let directUri: string
    try {
      directUri = await this.seedResolver(uri)
    } catch (error) {
      console.error('[MongoDB]', JSON.stringify({ stage: 'srv-fallback', category: 'DNS_FAILED',
        hint: 'DNS-over-HTTPS SRV resolution failed. Set a direct mongodb:// seed list in MONGODB_URI or repair the network resolver.',
        reason: error instanceof Error ? error.message.slice(0, 200) : 'unknown' }))
      throw new MongoUnavailableError()
    }
    const second = await this.open(directUri, name, performance.now())
    if ('db' in second) return second.db
    this.fail(second)
  }
  // The system resolver can mangle SRV answers (EBADRESP); a direct seed list bypasses it entirely.
  private canRetryOverDoh(uri: string, error: unknown): boolean {
    if (this.env.MONGODB_SRV_DOH_FALLBACK === 'false') return false
    return isSrvUri(uri) && isDnsResolutionFailure(error)
  }
  private fail(failure: ConnectionFailure): never {
    console.error('[MongoDB]', JSON.stringify({ stage: failure.stage, ...diagnoseMongoFailure(failure.error) }))
    throw new MongoUnavailableError()
  }
  private async open(uri: string, name: string, startedAt: number): Promise<{ db: Db } | ConnectionFailure> {
    let stage = 'connect'
    try {
      this.client = this.factory(uri)
      await this.client.connect()
      const connected = performance.now()
      const db = this.client.db(name)
      stage = 'indexes'
      if (this.env.MONGO_SKIP_INDEX_INIT !== 'true') await ensureIndexes(db)
      console.info('[MongoLatency]', JSON.stringify({ connectionMs: connected - startedAt, indexInitializationMs: performance.now() - connected }))
      console.log('MongoDB application database initialized')
      return { db }
    } catch (error) {
      await this.client?.close().catch(() => {})
      this.client = undefined
      return { stage, error }
    }
  }
  async close() {
    await this.pending?.catch(() => {})
    await this.client?.close()
    this.client = undefined; this.pending = undefined
  }
  async transaction<T>(work: (db: Db, session: ClientSession) => Promise<T>): Promise<T> {
    const db = await this.get(), session = this.client!.startSession()
    try { return await session.withTransaction(() => work(db, session)) }
    finally { await session.endSession() }
  }
}
export const mongoDatabase = new MongoDatabase()
