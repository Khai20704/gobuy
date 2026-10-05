import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile, rename, readdir, unlink, rmdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { mongoDatabase, storageMode } from './mongo.js'

export interface AssetStore<T> {
  get(userId: string, id: string): Promise<T | undefined>
  put(userId: string, id: string, value: T, once?: boolean): Promise<void>
  list(userId: string, limit?: number): Promise<T[]>
  take(userId: string, id: string): Promise<T | undefined>
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
export class MongoAssetStore<T> implements AssetStore<T> {
  constructor(private readonly name: string) {}
  private async collection() { return (await mongoDatabase.get()).collection<{ _id: string; userId: string; value: T }>(this.name) }
  async get(userId: string, id: string) { return (await (await this.collection()).findOne({ _id: hash(userId + ':' + id), userId }))?.value }
  async put(userId: string, id: string, value: T, once = false) {
    await (await this.collection()).updateOne({ _id: hash(userId + ':' + id), userId }, once ? { $setOnInsert: { userId, value } } : { $set: { userId, value } }, { upsert: true })
  }
  async list(userId: string, limit = 100) {
    return (await (await this.collection()).find({ userId }).limit(Math.max(1, Math.min(10000, limit))).toArray()).map(row => row.value)
  }
  async take(userId: string, id: string) { return (await (await this.collection()).findOneAndDelete({ _id: hash(userId + ':' + id), userId }))?.value }
}
export class FileAssetStore<T> implements AssetStore<T> {
  constructor(private readonly directory: string) {}
  private folder(userId: string) { return join(this.directory, hash(userId)) }
  private path(userId: string, id: string) { return join(this.folder(userId), hash(id) + '.json') }
  async get(userId: string, id: string): Promise<T | undefined> {
    try { return JSON.parse(await readFile(this.path(userId, id), 'utf8')) as T }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw e }
  }
  async put(userId: string, id: string, value: T, once = false) {
    await mkdir(this.folder(userId), { recursive: true, mode: 0o700 })
    const path = this.path(userId, id)
    if (once) {
      try { await writeFile(path, JSON.stringify(value), { flag: 'wx', mode: 0o600 }) }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e }
      return
    }
    const temporary = path + '.' + randomUUID() + '.tmp'
    await writeFile(temporary, JSON.stringify(value), { mode: 0o600 }); await rename(temporary, path)
  }
  async list(userId: string, limit = 100): Promise<T[]> {
    try {
      const files = (await readdir(this.folder(userId))).filter(f => /^[a-f0-9]{64}\.json$/.test(f))
        .slice(0, Math.max(1, Math.min(10000, limit)))
      return await Promise.all(files.map(async file => JSON.parse(await readFile(join(this.folder(userId), file), 'utf8')) as T))
    } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []; throw e }
  }
  async take(userId: string, id: string): Promise<T | undefined> {
    const path = this.path(userId, id), lock = path + '.consume-lock'
    // Directory creation is exclusive on Windows too; concurrent renames are not a reliable mutex there.
    try { await mkdir(lock) }
    catch (e) { if (['ENOENT', 'EEXIST'].includes((e as NodeJS.ErrnoException).code ?? '')) return undefined; throw e }
    try {
      const value = await this.get(userId, id)
      if (value !== undefined) await unlink(path)
      return value
    } finally { await rmdir(lock) }
  }
}
export function assetStore<T>(name: string): AssetStore<T> {
  if (!/^[a-zA-Z]+$/.test(name)) throw new Error('Invalid store name')
  return storageMode() === 'file' ? new FileAssetStore<T>(resolve(process.env.ASSET_DATA_DIR || '.data/assets', name)) : new MongoAssetStore<T>(name)
}
