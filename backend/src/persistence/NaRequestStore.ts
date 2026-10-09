import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { naRequestSchema, type PurchasePhase } from '@gobuy/shared'
import { mongoDatabase, type DatabaseProvider } from './mongo.js'

export type NaRequestStatus = 'PROCESSING' | 'NEEDS_INPUT' | 'NO_MATCH' | 'QUOTED' | 'PENDING' | 'CONFIRMED' | 'FAILED' | 'NOT_SUBMITTED'
export type NaRequest = {
  id: string
  conversationId?: string
  prompt: string
  status: NaRequestStatus
  phase?: PurchasePhase
  response?: string
  orderId?: string
  title?: string
  signature?: string
  createdAt: string
  updatedAt: string
}
export type NaRequestUpdate = Pick<NaRequest, 'status'> & Partial<Pick<NaRequest, 'response' | 'orderId' | 'title' | 'signature' | 'phase' | 'conversationId'>>
export interface NaRequestStore {
  create(userId: string, id: string, prompt: string): Promise<void>
  update(userId: string, id: string, update: NaRequestUpdate): Promise<void>
  list(userId: string, limit?: number): Promise<NaRequest[]>
}

type NaRequestDocument = Omit<NaRequest, 'createdAt' | 'updatedAt'> & {
  ownerUid: string
  createdAt: Date
  updatedAt: Date
}
const toRequest = ({ ownerUid: _ownerUid, createdAt, updatedAt, ...request }: NaRequestDocument): NaRequest => ({
  ...request, createdAt: createdAt.toISOString(), updatedAt: updatedAt.toISOString(),
})

export class MongoNaRequestStore implements NaRequestStore {
  constructor(private readonly database: DatabaseProvider = mongoDatabase.get) {}
  private async collection() { return (await this.database()).collection<NaRequestDocument>('naRequests') }
  async create(userId: string, id: string, prompt: string) {
    const now = new Date()
    await (await this.collection()).insertOne({
      id, ownerUid: userId, prompt, status: 'PROCESSING', createdAt: now, updatedAt: now,
    })
  }
  async update(userId: string, id: string, update: NaRequestUpdate) {
    const result = await (await this.collection()).updateOne(
      { id, ownerUid: userId },
      { $set: { ...update, updatedAt: new Date() } },
    )
    if (result.matchedCount !== 1) throw new Error('Request history record not found for this account.')
  }
  async list(userId: string, limit = 50) {
    const rows = await (await this.collection()).find({ ownerUid: userId }).sort({ createdAt: -1 }).limit(limit).toArray()
    return rows.map(toRequest)
  }
}

export class FileNaRequestStore implements NaRequestStore {
  private readonly queues = new Map<string, Promise<unknown>>()
  constructor(private readonly directory = resolve(process.env.NA_REQUESTS_DATA_DIR || '.data/na-requests')) {}
  private path(userId: string) {
    return join(this.directory, createHash('sha256').update(userId).digest('hex') + '.json')
  }
  private async read(userId: string): Promise<NaRequest[]> {
    try {
      const value: unknown = JSON.parse(await readFile(this.path(userId), 'utf8'))
      if (!Array.isArray(value)) throw new Error('Invalid saved Na request history.')
      return naRequestSchema.array().parse(value)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
  }
  private async change(userId: string, update: (requests: NaRequest[]) => NaRequest[]) {
    const path = this.path(userId)
    const operation = (this.queues.get(path) ?? Promise.resolve()).catch(() => {}).then(async () => {
      const requests = update(await this.read(userId))
      await mkdir(this.directory, { recursive: true, mode: 0o700 })
      const temporary = path + '.' + randomUUID() + '.tmp'
      await writeFile(temporary, JSON.stringify(requests), { encoding: 'utf8', mode: 0o600 })
      await rename(temporary, path)
    })
    this.queues.set(path, operation)
    try { await operation }
    finally { if (this.queues.get(path) === operation) this.queues.delete(path) }
  }
  async create(userId: string, id: string, prompt: string) {
    await this.change(userId, requests => {
      if (requests.some(request => request.id === id)) throw new Error('Duplicate Na request ID.')
      const now = new Date().toISOString()
      return [{ id, prompt, status: 'PROCESSING', createdAt: now, updatedAt: now }, ...requests]
    })
  }
  async update(userId: string, id: string, update: NaRequestUpdate) {
    await this.change(userId, requests => {
      const index = requests.findIndex(request => request.id === id)
      if (index < 0) throw new Error('Request history record not found for this account.')
      requests[index] = { ...requests[index], ...update, updatedAt: new Date().toISOString() }
      return requests
    })
  }
  async list(userId: string, limit = 50) {
    return (await this.read(userId)).slice(0, limit)
  }
}

export function createNaRequestStore(): NaRequestStore {
  return process.env.APP_STORAGE === 'file' ? new FileNaRequestStore() : new MongoNaRequestStore()
}
