import { MongoDatabase, MongoUnavailableError } from '../persistence/mongo.js'

// Read-only connectivity probe. It uses the same connection path as the API, including the
// DNS-over-HTTPS SRV fallback, but skips index initialization, collection reads and writes.
const database = new MongoDatabase({ ...process.env, MONGO_SKIP_INDEX_INIT: 'true' })
try {
  const db = await database.get()
  await db.command({ ping: 1 })
  console.log('MongoDB connection and ping succeeded. Application index permissions have not been tested.')
} catch (error) {
  const reason = error instanceof MongoUnavailableError
    ? 'connection failed; see the [MongoDB] diagnostic logged above'
    : error instanceof Error ? error.message : 'connection failed'
  console.error('[MongoDB check]', reason)
  process.exitCode = 1
} finally { await database.close() }
