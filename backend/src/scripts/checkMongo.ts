import { MongoClient } from 'mongodb'
import { diagnoseMongoFailure } from '../persistence/mongoDiagnostics.js'

// Read-only connectivity probe. No ensureIndexes, collection reads, writes or raw error logging.
let client: MongoClient | undefined
try {
  if (!process.env.MONGODB_URI?.trim()) throw new Error('missing-config')
  client = new MongoClient(process.env.MONGODB_URI, { maxPoolSize: 1, serverSelectionTimeoutMS: 8000, connectTimeoutMS: 8000 })
  await client.connect()
  await client.db(process.env.MONGODB_DB_NAME || 'gobuy').command({ ping: 1 })
  console.log('MongoDB connection and ping succeeded. Application index permissions have not been tested.')
} catch (error) {
  if (!process.env.MONGODB_URI?.trim()) console.error('MONGODB_URI is missing in backend/.env.')
  else console.error('[MongoDB check]', JSON.stringify(diagnoseMongoFailure(error)))
  process.exitCode = 1
} finally { await client?.close().catch(() => {}) }
