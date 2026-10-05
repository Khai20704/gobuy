import { createHash } from 'node:crypto'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { shippingAddressSchema, type ShippingAddress } from '@gobuy/shared'

export type MigrationCounts = { migrated: number; skipped: number; failed: number; wouldMigrate: number }
export type ProfileImport = { firebaseUid: string; address: ShippingAddress; createdAt: Date; updatedAt: Date }
export async function migrateProfiles(directory: string, uids: Iterable<string>, apply: boolean,
  insert: (value: ProfileImport) => Promise<boolean>): Promise<MigrationCounts> {
  const counts = { migrated: 0, skipped: 0, failed: 0, wouldMigrate: 0 }
  const owners = new Map(Array.from(uids, uid => [createHash('sha256').update(uid).digest('hex') + '.json', uid]))
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue
    const uid = owners.get(entry.name)
    if (!uid) { counts.skipped++; continue }
    try {
      const path = join(directory, entry.name)
      const address = shippingAddressSchema.parse(JSON.parse(await readFile(path, 'utf8')))
      const info = await stat(path)
      if (!apply) { counts.wouldMigrate++; continue }
      if (await insert({ firebaseUid: uid, address, createdAt: info.birthtime, updatedAt: info.mtime })) counts.migrated++
      else counts.skipped++
    } catch { counts.failed++ }
  }
  return counts
}
