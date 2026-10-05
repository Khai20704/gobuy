import { applicationDefault, initializeApp } from 'firebase-admin/app'
import { getAuth } from 'firebase-admin/auth'
import { readdir, readFile, stat } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { z } from 'zod'
import { nftDemoQuoteSchema } from '@gobuy/shared'
import { mongoDatabase } from '../persistence/mongo.js'
import { migrateProfiles, type MigrationCounts } from '../persistence/migrateProfiles.js'
import { storedSchema } from '../services/twin/TwinStore.js'

const orderSchema = z.object({ userId: z.string().min(1).optional(), text: z.string(), quote: nftDemoQuoteSchema,
  signature: z.string().optional(), signed: z.string().optional() }).strict()
const args = process.argv.slice(2)
const apply = args.includes('--apply')
const option = (key: string, fallback: string) => { const index = args.indexOf(key); return index < 0 ? fallback : args[index + 1] || fallback }
try {
  // Enumerate authoritative Firebase UIDs; hashed legacy filenames are never treated as UIDs.
  const projectId = process.env.FIREBASE_PROJECT_ID
  if (!projectId) throw new Error('Missing project')
  const emulator = process.env.FIREBASE_AUTH_EMULATOR_HOST
  if (emulator && (process.env.NODE_ENV === 'production' || !projectId.startsWith('demo-') || !/^(localhost|127\.0\.0\.1):\d+$/.test(emulator))) throw new Error('Unsafe emulator')
  const auth = getAuth(initializeApp({ projectId, ...(emulator ? {} : { credential: applicationDefault() }) }, 'mongo-migration'))
  const uids: string[] = []
  let pageToken: string | undefined
  do {
    const page = await auth.listUsers(1000, pageToken)
    uids.push(...page.users.map(user => user.uid)); pageToken = page.pageToken
  } while (pageToken)
  const db = apply ? await mongoDatabase.get() : undefined
  const accounts = await migrateProfiles(resolve(option('--accounts-dir', process.env.ACCOUNT_DATA_DIR || '.data/accounts')), uids, apply, async value => {
    const result = await db!.collection('users').updateOne({ firebaseUid: value.firebaseUid, address: { $exists: false } }, {
      $set: { address: value.address, updatedAt: value.updatedAt },
      $setOnInsert: { firebaseUid: value.firebaseUid, createdAt: value.createdAt },
    }, { upsert: true }).catch(error => { if ((error as { code?: number }).code === 11000) return null; throw error })
    return !!result && !!(result.upsertedCount || result.modifiedCount)
  })
  console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', accounts }))
  let failures = accounts.failed
  // Optional migration of existing order and anonymous Twin data; never import seller keypairs.
  for (const kind of ['orders', 'twins'] as const) {
    if (!args.includes('--' + kind + '-dir')) continue
    const directory = resolve(option('--' + kind + '-dir', ''))
    const counts: MigrationCounts = { migrated: 0, skipped: 0, failed: 0, wouldMigrate: 0 }
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const pattern = kind === 'orders' ? /^[a-f0-9-]{36}\.json$/ : /^[a-f0-9]{64}\.json$/
      if (!entry.isFile() || !pattern.test(entry.name)) continue
      try {
        const path = join(directory, entry.name), raw: unknown = JSON.parse(await readFile(path, 'utf8'))
        const info = await stat(path)
        const id = entry.name.slice(0, -5)
        let document: Record<string, unknown>, filter: Record<string, string>
        if (kind === 'orders') {
          const order = orderSchema.parse(raw)
          if (order.quote.id !== id) throw new Error('Mismatched ID')
          filter = { orderId: id }
          document = { orderId: id, text: order.text, quote: order.quote, createdAt: info.birthtime, updatedAt: info.mtime,
            ...(order.userId ? { ownerUid: order.userId } : {}), ...(order.signature ? { signature: order.signature } : {}), ...(order.signed ? { signed: order.signed } : {}) }
        } else {
          filter = { session: id }; document = { session: id, value: storedSchema.parse(raw), revision: 0 }
        }
        if (!apply) { counts.wouldMigrate++; continue }
        const result = await db!.collection(kind === 'orders' ? 'orders' : 'commerceTwins').updateOne(filter, { $setOnInsert: document }, { upsert: true })
        if (result.upsertedCount) counts.migrated++; else counts.skipped++
      } catch { counts.failed++ }
    }
    console.log(JSON.stringify({ [kind]: counts })); failures += counts.failed
  }
  if (failures) process.exitCode = 1
} catch {
  console.error('Migration failed. Check source directories, Firebase Admin credentials and Mongo configuration. Source files were not deleted.')
  process.exitCode = 1
} finally { await mongoDatabase.close() }
