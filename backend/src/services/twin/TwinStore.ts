import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { actionLogSchema, decisionSchema, twinPreferencesSchema } from '@gobuy/shared'

export const storedSchema = z.object({ explicit: twinPreferencesSchema, history: z.array(decisionSchema).max(200), actions: z.array(actionLogSchema).max(200).default([]) }).strict()
export type StoredTwin = z.infer<typeof storedSchema>
export interface TwinStore {
  read(session: string): Promise<StoredTwin>
  update(session: string, change: (value: StoredTwin) => StoredTwin): Promise<StoredTwin>
}
const empty = (): StoredTwin => ({ explicit: {}, history: [], actions: [] })
export class MemoryTwinStore implements TwinStore {
  private readonly values = new Map<string, StoredTwin>()
  async read(session: string) { return structuredClone(this.values.get(session) ?? empty()) }
  async update(session: string, change: (value: StoredTwin) => StoredTwin) {
    const value = storedSchema.parse(change(structuredClone(this.values.get(session) ?? empty())))
    this.values.set(session, value); return structuredClone(value)
  }
}
// Local MVP persistence, one atomic file per anonymous browser session. Replace behind TwinStore for multi-instance hosting.
export class FileTwinStore implements TwinStore {
  private readonly queues = new Map<string, Promise<unknown>>()
  constructor(private readonly directory: string) {}
  private path(session: string) {
    if (!/^[a-f0-9]{64}$/.test(session)) throw new Error('Invalid session storage key')
    return join(this.directory, session + '.json')
  }
  async read(session: string): Promise<StoredTwin> {
    try { return storedSchema.parse(JSON.parse(await readFile(this.path(session), 'utf8'))) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return empty()
      throw new Error('Commerce Twin storage unavailable')
    }
  }
  async update(session: string, change: (value: StoredTwin) => StoredTwin): Promise<StoredTwin> {
    const operation = (this.queues.get(session) ?? Promise.resolve()).catch(() => {}).then(async () => {
      const value = storedSchema.parse(change(await this.read(session)))
      await mkdir(this.directory, { recursive: true })
      const target = this.path(session), temporary = target + '.' + randomUUID() + '.tmp'
      await writeFile(temporary, JSON.stringify(value), { encoding: 'utf8', mode: 0o600 })
      await rename(temporary, target)
      return value
    })
    this.queues.set(session, operation)
    try { return await operation }
    finally { if (this.queues.get(session) === operation) this.queues.delete(session) }
  }
}
