import { readFile, writeFile, rename } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { rwaAssetSchema, type RWAAsset } from '@gobuy/shared'
import { mongoDatabase, storageMode } from '../src/persistence/mongo.js'
import { XStocksSync, mergeIssuerAssets, XSTOCKS_ASSETS_URL, XSTOCKS_DEPLOYMENT_MAPPING } from '../src/services/rwa/XStocksSync.js'
import { RWA_APPROVED_LIST, RWA_REGISTRY_CAPACITY } from '../src/services/rwa/RWARegistry.js'
import { fetchJson } from '../src/services/search/http.js'

// Explicit operator worker, never imported by chat. Defaults to read-only dry run.
const arg = (name: string) => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1] }
const source = arg('--source') ?? 'xstocks'
if (source !== 'xstocks') throw new Error('Only the xstocks source is supported.')
if (process.argv.includes('--inspect')) {
  const response = await fetchJson(`${XSTOCKS_ASSETS_URL}?page=0&pageSize=5`, { signal: AbortSignal.timeout(15000) })
  console.log(JSON.stringify(response, null, 2))
  process.exit(0) // read-only: no database, RPC or approval writes
}
const networkField = arg('--network-field') ?? XSTOCKS_DEPLOYMENT_MAPPING.networkField
const mintField = arg('--mint-field') ?? XSTOCKS_DEPLOYMENT_MAPPING.mintField
const solanaNetwork = arg('--solana-network') ?? XSTOCKS_DEPLOYMENT_MAPPING.solanaNetwork
const apply = process.argv.includes('--apply'), watch = process.argv.includes('--watch')
if (watch && !apply) throw new Error('--watch requires --apply; review a dry run first.')
const sync = new XStocksSync({ networkField, mintField, solanaNetwork }, undefined, undefined, undefined,
  count => console.log(`Đã thu thập ${count} deployment từ issuer trên các blockchain; chưa ghi allowlist.`))
async function run() {
  const incoming = await sync.collect() // finish every page and on-chain check before any write
  const collection = storageMode() === 'mongo' ? (await mongoDatabase.get()).collection(RWA_APPROVED_LIST) : undefined
  const path = process.env.RWA_APPROVED_LIST_PATH || process.env.RWA_REGISTRY_PATH
  if (!collection && !path) throw new Error('Configure a registry file for file storage.')
  const raw = collection ? await collection.find({}, { projection: { _id: 0 } }).limit(RWA_REGISTRY_CAPACITY + 1).toArray()
    : await readFile(path!, 'utf8').then(JSON.parse).catch(error => { if (error.code === 'ENOENT') return []; throw error })
  const existing = z.array(rwaAssetSchema).max(RWA_REGISTRY_CAPACITY).parse(raw)
  const merged = mergeIssuerAssets(existing, incoming)
  console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', issuerAssets: incoming.length, total: merged.length,
    added: merged.filter(row => !existing.some(old => old.mint === row.mint)).map(row => ({ symbol: row.symbol, mint: row.mint })),
    disabled: merged.filter(row => !row.verified || !row.allowedForSwap).map(row => row.symbol) }, null, 2))
  if (!apply) return
  if (collection) {
    await collection.createIndex({ mint: 1 }, { unique: true })
    for (const row of merged) {
      const old = existing.find(entry => entry.mint === row.mint)
      // Optimistic filters preserve concurrent administrator edits/revocations.
      if (!old) await collection.updateOne({ mint: row.mint }, { $setOnInsert: row }, { upsert: true })
      else if (old.syncSource === 'xstocks-v2') {
        const result = await collection.updateOne({ ...old }, { $set: row })
        if (!result.matchedCount) throw new Error('Registry changed during sync; retry after reviewing concurrent edits.')
      }
    }
  } else {
    // Single operator writer required for the development file store.
    const temporary = path! + '.' + randomUUID() + '.tmp'
    await writeFile(temporary, JSON.stringify(merged satisfies RWAAsset[], null, 2))
    await rename(temporary, path!)
  }
  console.log(`Completed ${source} sync: ${incoming.length} issuer assets checked; ${merged.length} registry entries.`)
}
do {
  try { await run() }
  catch (error) { console.error(error instanceof Error ? error.message : 'Issuer sync failed'); if (!watch) process.exit(1) }
  if (watch) await new Promise(resolve => setTimeout(resolve, 60 * 60 * 1000))
} while (watch)
process.exit(0)
