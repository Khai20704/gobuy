import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Db, MongoClient } from 'mongodb'
import { MongoDatabase, MongoUnavailableError } from '../src/persistence/mongo.js'
import { isDnsResolutionFailure } from '../src/persistence/mongoDiagnostics.js'
import { buildDirectUri, isSrvUri, parseSrvAnswers, parseTxtAnswers, resolveDirectUri, srvLookupName } from '../src/persistence/srvResolution.js'

const SRV_URI = 'mongodb+srv://app%40owner:p%3Assw0rd@cluster0.eeywd.mongodb.net/?appName=Cluster0'
const DIRECT_URI = 'mongodb://app%40owner:p%3Assw0rd@cluster0-shard-00-00.eeywd.mongodb.net:27017/?appName=Cluster0&tls=true'
const SRV_ANSWERS = [
  { type: 33, data: '0 0 27017 cluster0-shard-00-00.eeywd.mongodb.net' },
  { type: 33, data: '0 0 27017 cluster0-shard-00-01.eeywd.mongodb.net' },
  { type: 33, data: '0 0 27017 cluster0-shard-00-02.eeywd.mongodb.net' },
]
const TXT_ANSWERS = [{ type: 16, data: '"authSource=admin&replicaSet=atlas-z48z23-shard-0"' }]

const fakeDb = () => ({ collection: () => ({ createIndex: async () => 'index' }) }) as unknown as Db
const fakeClient = (db: Db) => ({ async connect() {}, db: () => db, async close() {} }) as unknown as MongoClient
const dnsError = () => Object.assign(new Error('querySrv EBADRESP _mongodb._tcp.cluster0.eeywd.mongodb.net'), { code: 'EBADRESP' })

/** The URL API rejects multi-host seed lists, so split the connection string by hand. */
function inspect(uri: string) {
  const authority = uri.trim().slice(uri.indexOf('://') + 3).split('/')[0] ?? ''
  const at = authority.lastIndexOf('@')
  return {
    credentials: at < 0 ? '' : authority.slice(0, at),
    hosts: at < 0 ? authority : authority.slice(at + 1),
    params: new URLSearchParams(uri.split('?')[1] ?? ''),
  }
}

function dohStub(responses: Record<string, unknown>, calls: string[] = []) {
  return async (input: string | URL | Request) => {
    const url = String(input)
    calls.push(url)
    const key = url.includes('type=SRV') ? 'SRV' : 'TXT'
    const payload = responses[key]
    if (payload === undefined) throw new Error('network down')
    return { ok: true, status: 200, json: async () => payload } as unknown as Response
  }
}

test('SRV URIs are detected and mapped to their lookup name', () => {
  assert.equal(isSrvUri(SRV_URI), true)
  assert.equal(isSrvUri('  MONGODB+SRV://host/?appName=x'), true)
  assert.equal(isSrvUri('mongodb://host:27017/?replicaSet=r'), false)
  assert.equal(isSrvUri('secret-uri'), false)
  assert.equal(srvLookupName(SRV_URI), '_mongodb._tcp.cluster0.eeywd.mongodb.net')
})

test('SRV and TXT answers are parsed and malformed records are discarded', () => {
  assert.deepEqual(parseSrvAnswers(SRV_ANSWERS), [
    { host: 'cluster0-shard-00-00.eeywd.mongodb.net', port: 27017 },
    { host: 'cluster0-shard-00-01.eeywd.mongodb.net', port: 27017 },
    { host: 'cluster0-shard-00-02.eeywd.mongodb.net', port: 27017 },
  ])
  assert.deepEqual(parseSrvAnswers([{ type: 5, data: 'alias.example.net.' }, { type: 33, data: 'nonsense' }]), [])
  assert.deepEqual(parseTxtAnswers(TXT_ANSWERS), ['authSource=admin&replicaSet=atlas-z48z23-shard-0'])
  assert.deepEqual(parseTxtAnswers([{ type: 33, data: '0 0 27017 host.' }]), [])
})

test('a direct seed list keeps encoded credentials, merges TXT options and enables TLS', () => {
  const uri = buildDirectUri(SRV_URI, parseSrvAnswers(SRV_ANSWERS), parseTxtAnswers(TXT_ANSWERS))
  const { credentials, hosts, params } = inspect(uri)
  assert.equal(uri.startsWith('mongodb://'), true)
  assert.equal(credentials, 'app%40owner:p%3Assw0rd')
  assert.equal(hosts, 'cluster0-shard-00-00.eeywd.mongodb.net:27017,cluster0-shard-00-01.eeywd.mongodb.net:27017,cluster0-shard-00-02.eeywd.mongodb.net:27017')
  assert.equal(params.get('appName'), 'Cluster0')
  assert.equal(params.get('authSource'), 'admin')
  assert.equal(params.get('replicaSet'), 'atlas-z48z23-shard-0')
  assert.equal(params.get('tls'), 'true')
  assert.throws(() => buildDirectUri(SRV_URI, []), /At least one SRV endpoint/)
})

test('explicit URI options win over the TXT record and an existing ssl option is kept', () => {
  const uri = buildDirectUri('mongodb+srv://owner:pw@cluster.example.net/?authSource=custom&ssl=true',
    [{ host: 'shard.example.net', port: 27017 }], parseTxtAnswers(TXT_ANSWERS))
  const { params } = inspect(uri)
  assert.equal(params.get('authSource'), 'custom')
  assert.equal(params.get('ssl'), 'true')
  assert.equal(params.get('tls'), null)
})

test('DNS-over-HTTPS resolution returns a seed list and falls back to the next endpoint', async () => {
  const calls: string[] = []
  const uri = await resolveDirectUri(SRV_URI, {
    endpoints: ['https://doh.example/one?format=json', 'https://doh.example/two'],
    fetchImpl: dohStub({ SRV: { Status: 0, Answer: SRV_ANSWERS }, TXT: { Status: 0, Answer: TXT_ANSWERS } }, calls),
  })
  assert.equal(inspect(uri).params.get('replicaSet'), 'atlas-z48z23-shard-0')
  assert.equal(calls[0], 'https://doh.example/one?format=json&name=_mongodb._tcp.cluster0.eeywd.mongodb.net&type=SRV')

  const retried: string[] = []
  const fallbackFetch = async (input: string | URL | Request) => {
    const url = String(input)
    retried.push(url)
    if (url.startsWith('https://doh.example/one')) throw new Error('resolver hijacked')
    return { ok: true, status: 200, json: async () => url.includes('type=SRV') ? { Status: 0, Answer: SRV_ANSWERS } : { Status: 0, Answer: [] } } as unknown as Response
  }
  const fallbackUri = await resolveDirectUri(SRV_URI, { endpoints: ['https://doh.example/one', 'https://doh.example/two'], fetchImpl: fallbackFetch })
  assert.equal(inspect(fallbackUri).params.get('tls'), 'true')
  assert.ok(retried.some(url => url.startsWith('https://doh.example/two')))
})

test('DNS-over-HTTPS resolution reports failure without leaking credentials', async () => {
  await assert.rejects(resolveDirectUri(SRV_URI, {
    endpoints: ['https://doh.example/one'],
    fetchImpl: dohStub({ SRV: { Status: 3, Answer: [] } }),
  }), error => error instanceof Error && !error.message.includes('p%3Assw0rd') && /DNS status 3/.test(error.message))
  await assert.rejects(resolveDirectUri(SRV_URI, {
    endpoints: ['https://doh.example/one'],
    fetchImpl: dohStub({ SRV: { Status: 0, Answer: [] } }),
  }), /returned no SRV records/)
})

test('a DNS-mangled SRV lookup retries over DNS-over-HTTPS and connects', async () => {
  const db = fakeDb(), attempted: string[] = []
  const database = new MongoDatabase({ MONGODB_URI: SRV_URI, MONGODB_DB_NAME: 'gobuy' }, uri => {
    attempted.push(uri)
    if (isSrvUri(uri)) throw dnsError()
    return fakeClient(db)
  }, async () => DIRECT_URI)
  assert.equal(await database.get(), db)
  assert.deepEqual(attempted, [SRV_URI, DIRECT_URI])
  await database.close()
})

test('non-DNS failures and a disabled fallback never retry or resolve seeds', async () => {
  const authFailure: string[] = []
  const authDatabase = new MongoDatabase({ MONGODB_URI: SRV_URI }, uri => {
    authFailure.push(uri)
    throw Object.assign(new Error('Authentication failed'), { code: 18 })
  }, async () => { throw new Error('seed resolution must not run') })
  await assert.rejects(authDatabase.get(), error => error instanceof MongoUnavailableError)

  const disabled: string[] = []
  const disabledDatabase = new MongoDatabase({ MONGODB_URI: SRV_URI, MONGODB_SRV_DOH_FALLBACK: 'false' }, uri => {
    disabled.push(uri)
    throw dnsError()
  }, async () => { throw new Error('seed resolution must not run') })
  await assert.rejects(disabledDatabase.get(), error => error instanceof MongoUnavailableError)

  const directTypo: string[] = []
  const directDatabase = new MongoDatabase({ MONGODB_URI: 'mongodb+srv://owner:pw@cluster.example.net/?appName=x' }, () => {
    directTypo.push('attempt')
    throw new Error('ECONNREFUSED')
  }, async () => { throw new Error('seed resolution must not run') })
  await assert.rejects(directDatabase.get(), error => error instanceof MongoUnavailableError)

  assert.deepEqual(authFailure, [SRV_URI])
  assert.deepEqual(disabled, [SRV_URI])
  assert.deepEqual(directTypo, ['attempt'])
})

test('a failing DNS-over-HTTPS retry fails closed and allows recovery on a later request', async () => {
  const db = fakeDb(), attempted: string[] = []
  let seeds = 0
  const database = new MongoDatabase({ MONGODB_URI: SRV_URI }, uri => {
    attempted.push(uri)
    if (isSrvUri(uri)) throw dnsError()
    return fakeClient(db)
  }, async () => { seeds++; if (seeds === 1) throw new Error('DNS-over-HTTPS blocked'); return DIRECT_URI })
  await assert.rejects(database.get(), error => error instanceof MongoUnavailableError)
  assert.equal(attempted.length, 1, 'no seed list means no second driver attempt')
  assert.equal(await database.get(), db, 'the next request retries initialization')
  assert.deepEqual(attempted, [SRV_URI, SRV_URI, DIRECT_URI])
})

test('DNS resolver codes are recognised so the startup log never reports UNKNOWN', () => {
  for (const code of ['EBADRESP', 'ENOTFOUND', 'EAI_AGAIN', 'ESERVFAIL', 'ENODATA', 'ETIMEOUT', 'EREFUSED', 'EFORMERR', 'ENOTIMP']) {
    assert.equal(isDnsResolutionFailure({ name: 'Error', code }), true, code)
  }
  assert.equal(isDnsResolutionFailure({ reason: { cause: { code: 'EBADRESP' } } }), true)
  assert.equal(isDnsResolutionFailure({ code: 18 }), false)
  assert.equal(isDnsResolutionFailure({ code: 'ETIMEDOUT' }), false)
  assert.equal(isDnsResolutionFailure(new Error('secret')), false)
})
