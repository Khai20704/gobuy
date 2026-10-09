import { MongoClient } from 'mongodb'
import { RWARegistry } from '../src/services/rwa/RWARegistry.js'
import { classifyAssetIntent } from '../src/services/rwa/classification.js'
import { ensureIndexes } from '../src/persistence/mongo.js'
const client = new MongoClient(process.env.MONGODB_URI!, { monitorCommands: true, serverSelectionTimeoutMS: 8000, connectTimeoutMS: 8000 })
const commands: { command: string; durationMs: number }[] = []
client.on('commandSucceeded', event => { commands.push({ command: event.commandName, durationMs: event.duration }) })
try {
  const start = performance.now(); await client.connect(); const connected = performance.now()
  const db = client.db(process.env.MONGODB_DB_NAME || 'gobuy')
  await ensureIndexes(db); const indexed = performance.now()
  console.log(JSON.stringify({ connectionMs: connected - start, indexInitializationMs: indexed - connected }))
  for (const run of ['cold', 'warm']) {
    commands.length = 0
    const begin = performance.now()
    const rows = await db.collection('RWA_APPROVED_LIST').find({}, { projection: { _id: 0 }, maxTimeMS: 5000, timeoutMS: 60000 }).batchSize(10000).toArray()
    const fetched = performance.now(); const registry = new RWARegistry(rows as never); const validated = performance.now()
    const explain = await db.collection('RWA_APPROVED_LIST').find({ mint: rows[0]?.mint }, { maxTimeMS: 3000 }).explain('executionStats')
    const execution = explain.executionStats
    const fullExplain = await db.collection('RWA_APPROVED_LIST').find({}, { maxTimeMS: 5000 }).explain('executionStats')
    console.log(JSON.stringify({ run, rows: rows.length, queryTransferDecodeMs: fetched - begin,
      validationMs: validated - fetched, responseJsonBytes: Buffer.byteLength(JSON.stringify(rows)), commands,
      fullServerExecutionMs: fullExplain.executionStats.executionTimeMillis,
      indexedLookup: { executionTimeMillis: execution.executionTimeMillis, totalDocsExamined: execution.totalDocsExamined, totalKeysExamined: execution.totalKeysExamined } }))
    const fast = performance.now()
    await classifyAssetIntent('Buy any nft under 1 SOL', () => false, async () => { throw new Error('Unexpected registry access') })
    console.log(JSON.stringify({ run, nftTotalMs: performance.now() - fast, registryRowsRead: 0, registrySize: registry.list().length }))
  }
} finally { await client.close() }
