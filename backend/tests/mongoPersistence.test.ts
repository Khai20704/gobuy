import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, writeFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import type { Db, MongoClient } from 'mongodb'
import express from 'express'
import { MongoProfileStore } from '../src/persistence/MongoProfileStore.js'
import { MongoOrderStore, type Order } from '../src/persistence/OrderStore.js'
import { MongoTwinStore } from '../src/persistence/MongoTwinStore.js'
import { MongoNaRequestStore } from '../src/persistence/NaRequestStore.js'
import { MongoDatabase, ensureIndexes, storageMode } from '../src/persistence/mongo.js'
import { migrateProfiles } from '../src/persistence/migrateProfiles.js'
import { createAccounts, type Identity } from '../src/auth/accounts.js'
import { NftDemoService } from '../src/services/nftDemo/NftDemoService.js'
import { DEVNET_GENESIS, shippingAddressSchema } from '@gobuy/shared'
import type { Connection } from '@solana/web3.js'

// Driver-boundary fake, not a Mongo server. Exercises filters/updates and unique constraints.
type Row = Record<string, unknown>
class CollectionFake {
  rows: Row[] = []
  indexes: { keys: Row; options: Row }[] = []
  async createIndex(keys: Row, options: Row) { this.indexes.push({ keys, options }) }
  private matches(row: Row, filter: Row) {
    return Object.entries(filter).every(([key, value]) => value && typeof value === 'object' && '$exists' in value
      ? (row[key] !== undefined) === (value as { $exists: boolean }).$exists : row[key] === value)
  }
  async findOne(filter: Row) { return structuredClone(this.rows.find(row => this.matches(row, filter)) ?? null) }
  async insertOne(row: Row) {
    if (this.indexes.some(index => index.options?.unique && this.rows.some(old => Object.keys(index.keys).every(key => old[key] === row[key])))) {
      throw Object.assign(new Error('duplicate'), { code: 11000 })
    }
    this.rows.push(structuredClone(row))
  }
  find(filter: Row) {
    let rows = this.rows.filter(row => this.matches(row, filter))
    const cursor = {
      sort: (sort: Row) => {
        const [[field, direction]] = Object.entries(sort)
        rows = [...rows].sort((a, b) => direction === -1
          ? new Date(b[field] as Date).getTime() - new Date(a[field] as Date).getTime()
          : new Date(a[field] as Date).getTime() - new Date(b[field] as Date).getTime())
        return cursor
      },
      limit: (count: number) => { rows = rows.slice(0, count); return cursor },
      toArray: async () => structuredClone(rows),
    }
    return cursor
  }
  async updateOne(filter: Row, update: { $set?: Row; $setOnInsert?: Row; $inc?: Record<string, number> }, options?: { upsert?: boolean }) {
    let row = this.rows.find(row => this.matches(row, filter))
    let upsertedCount = 0
    if (!row && options?.upsert) {
      const inserted = { ...Object.fromEntries(Object.entries(filter).filter(([, value]) => typeof value !== 'object')), ...update.$setOnInsert, ...update.$set }
      await this.insertOne(inserted); row = this.rows.at(-1)!; upsertedCount = 1
    } else if (!row) return { matchedCount: 0, modifiedCount: 0, upsertedCount: 0 }
    Object.assign(row, structuredClone(update.$set ?? {}))
    for (const [key, amount] of Object.entries(update.$inc ?? {})) row[key] = Number(row[key] ?? 0) + amount
    return { matchedCount: upsertedCount ? 0 : 1, modifiedCount: upsertedCount ? 0 : 1, upsertedCount }
  }
}
async function database() {
  const collections = new Map<string, CollectionFake>()
  const collection = (name: string) => { if (!collections.has(name)) collections.set(name, new CollectionFake()); return collections.get(name)! }
  const db = { collection } as unknown as Db
  await ensureIndexes(db)
  return { db, collection, get: async () => db }
}
const address = shippingAddressSchema.parse({ recipient: 'Test', country: 'VN', line1: '123 Test', city: 'Da Nang' })

test('Mongo profiles persist updates/reloads, keep one UID and isolate users', async () => {
  const fake = await database(), store = new MongoProfileStore(fake.get)
  assert.equal(await store.read('alice'), null)
  await store.syncIdentity({ uid: 'alice', email: 'a@example.test', phone: null })
  await store.save('alice', address)
  await store.save('alice', { ...address, city: 'Ho Chi Minh City' })
  assert.equal((await new MongoProfileStore(fake.get).read('alice'))?.city, 'Ho Chi Minh City')
  assert.equal(await store.read('bob'), null)
  assert.equal(fake.collection('users').rows.length, 1)
  await assert.rejects(fake.collection('users').insertOne({ firebaseUid: 'alice' }), /duplicate/)
  await assert.rejects(store.save('alice', { ...address, firebaseUid: 'bob' } as typeof address))
  await assert.rejects(new MongoProfileStore(async () => { throw new Error('offline') }).read('alice'), /offline/)
})

test('Mongo account API enforces token identity, phone verification and profile reload', async () => {
  const fake = await database()
  const identities: Record<string, Identity> = { alice: { uid: 'alice', email: null, phone: null }, bob: { uid: 'bob', email: null, phone: '+14155552671' } }
  const store = new MongoProfileStore(fake.get)
  const accounts = createAccounts({ async verify(token) { if (!identities[token]) throw new Error('invalid'); return identities[token] } }, store)
  const app = express(); app.use(express.json()); app.use('/account', accounts.router)
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(r => server.once('listening', r))
  const endpoint = server.address(); if (!endpoint || typeof endpoint === 'string') throw new Error('port')
  const call = (token?: string, body?: unknown) => fetch(`http://127.0.0.1:${endpoint.port}/account/${body ? 'address' : 'me'}`, {
    method: body ? 'PUT' : 'GET', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer '+token } : {}) }, body: body ? JSON.stringify(body) : undefined })
  try {
    assert.equal((await call()).status, 401); assert.equal((await call('forged')).status, 401)
    assert.equal((await call('alice', address)).status, 403)
    identities.alice.phone = '+84912345678'
    for (const field of ['uid', 'firebaseUid', 'phoneVerified', 'onboardingCompleted']) assert.equal((await call('alice', { ...address, [field]: 'bob' })).status, 400)
    assert.equal((await call('alice', address)).status, 200)
    assert.equal((await call('alice', { ...address, city: 'New City' })).status, 200)
    assert.equal((await (await call('alice')).json()).address.city, 'New City')
    assert.equal((await (await call('bob')).json()).address, null)
    assert.equal((await call()).status, 401, 'logout does not erase saved profile')
    assert.equal((await (await call('alice')).json()).ready, true, 'login reloads saved profile')
    identities.alice.phone = null
    assert.equal((await (await call('alice')).json()).ready, false, 'Mongo phone never overrides Firebase')
  } finally { await new Promise<void>(r => server.close(() => r())) }
})

function order(): Order {
  return { userId: 'alice', text: 'buy', quote: { id: crypto.randomUUID(), network: 'devnet', owner: 'wallet', asset: 'asset', title: 'Art', image: '/art',
    priceLamports: 1, maximumLamports: 10, estimatedTotalLamports: 2, transaction: 'wire', expiresAt: new Date().toISOString() } }
}
test('Mongo orders have immutable owners and atomic submission, legacy orders stay ownerless', async () => {
  const fake = await database(), store = new MongoOrderStore(fake.get), value = order()
  await store.create(value)
  await assert.rejects(store.create({ ...value, userId: 'bob' }), /duplicate/)
  assert.equal((await store.read(value.quote.id))?.userId, 'alice')
  assert.equal(await store.submit({ ...value, userId: 'bob', signature: 's', signed: 'wire' }), false)
  const submitted = { ...value, signature: 's', signed: 'wire' }
  assert.deepEqual(await Promise.all([store.submit(submitted), store.submit(submitted)]), [true, false])
  const legacy = order()
  await fake.collection('orders').insertOne({ orderId: legacy.quote.id, text: legacy.text, quote: legacy.quote })
  assert.equal(await store.submit({ ...legacy, signature: 's', signed: 'wire' }), false)
  const service = new NftDemoService(undefined, undefined, undefined, undefined, store)
  ;(service as unknown as { connection: Connection }).connection.getGenesisHash = async () => DEVNET_GENESIS
  await assert.rejects(service.status(value.quote.id, 'bob'), /another account/)
  await assert.rejects(service.status(legacy.quote.id, 'alice'), /another account/)
  assert.equal((await store.read(legacy.quote.id))?.userId, undefined)
})

test('Mongo Twin store validates session keys and persists isolated updates', async () => {
  const fake = await database(), store = new MongoTwinStore(fake.get), session = 'a'.repeat(64)
  await assert.rejects(store.read('$ne'), /Invalid session/)
  await store.update(session, value => value)
  await store.update(session, value => value)
  assert.equal(fake.collection('commerceTwins').rows.length, 1)
  assert.deepEqual(await store.read('b'.repeat(64)), { explicit: {}, history: [], actions: [] })
})

test('Mongo Na request history stores status transitions per authenticated user', async () => {
  const fake = await database(), store = new MongoNaRequestStore(fake.get)
  const id = crypto.randomUUID()
  await store.create('alice', id, 'Mua tranh NFT dưới 1 SOL')
  await store.update('alice', id, { status: 'QUOTED', response: 'Đã có báo giá.', title: 'Quiet Orbit', orderId: id })
  assert.equal((await store.list('alice'))[0].status, 'QUOTED')
  assert.equal((await store.list('alice'))[0].prompt, 'Mua tranh NFT dưới 1 SOL')
  assert.equal((await store.list('alice'))[0].title, 'Quiet Orbit')
  assert.deepEqual(await store.list('bob'), [])
  await assert.rejects(store.update('bob', id, { status: 'CONFIRMED' }), /not found/)
})

test('Mongo config fails closed, pools connections, sanitizes failures and closes', async () => {
  assert.equal(storageMode({}), 'mongo')
  assert.throws(() => storageMode({ APP_STORAGE: 'file', NODE_ENV: 'production' }))
  assert.throws(() => storageMode({ APP_STORAGE: 'typo' }))
  await assert.rejects(new MongoDatabase({}).get(), /MONGODB_URI/)
  await assert.rejects(new MongoDatabase({ MONGODB_URI: 'fake', FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099' }).get(), /separate/)
  const fake = await database(); let connects = 0, closes = 0
  const client = { async connect() { connects++ }, db() { return fake.db }, async close() { closes++ } } as unknown as MongoClient
  const db = new MongoDatabase({ MONGODB_URI: 'fake' }, () => client)
  await Promise.all([db.get(), db.get()]); assert.equal(connects, 1)
  await db.close(); assert.equal(closes, 1)
  const broken = new MongoDatabase({ MONGODB_URI: 'secret-uri' }, () => { throw new Error('secret-uri') })
  await assert.rejects(broken.get(), error => error instanceof Error && !error.message.includes('secret-uri'))
  let attempts = 0
  const recovering = new MongoDatabase({ MONGODB_URI: 'fake' }, () => {
    attempts++
    if (attempts === 1) throw new Error('temporary network error')
    return client
  })
  await assert.rejects(recovering.get(), /initialization failed/)
  assert.equal(await recovering.get(), fake.db)
  assert.equal(attempts, 2, 'A failed startup connection can recover on a later request.')
})

test('profile migration resolves hashes, skips unknown owners, validates and is idempotent', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mongo-migration-'))
  const filename = (uid: string) => createHash('sha256').update(uid).digest('hex')+'.json'
  await writeFile(join(directory, filename('alice')), JSON.stringify(address))
  await writeFile(join(directory, filename('unknown')), JSON.stringify(address))
  await writeFile(join(directory, filename('invalid')), '{')
  const seen = new Set<string>()
  const insert = async (value: { firebaseUid: string }) => { if (seen.has(value.firebaseUid)) return false; seen.add(value.firebaseUid); return true }
  assert.deepEqual(await migrateProfiles(directory, ['alice', 'invalid'], false, insert), { migrated: 0, skipped: 1, failed: 1, wouldMigrate: 1 })
  assert.equal(seen.size, 0)
  assert.equal((await migrateProfiles(directory, ['alice', 'invalid'], true, insert)).migrated, 1)
  assert.equal((await migrateProfiles(directory, ['alice', 'invalid'], true, insert)).migrated, 0)
  assert.equal((await readdir(directory)).length, 3)
})
