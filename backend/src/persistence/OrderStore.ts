import { mkdir, readFile, writeFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { NftDemoQuote } from '@gobuy/shared'
import { InputError } from '../schemas/search.js'
import { mongoDatabase, type DatabaseProvider } from './mongo.js'

export type Order = { userId?: string; text: string; quote: NftDemoQuote; signature?: string; signed?: string }
export interface OrderStore {
  read(id: string): Promise<Order | undefined>
  create(order: Order): Promise<void>
  submit(order: Order): Promise<boolean>
}
export class FileOrderStore implements OrderStore {
  constructor(private readonly directory: string) {}
  private path(id: string) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new InputError('Invalid order ID')
    return join(this.directory, id + '.json')
  }
  async read(id: string): Promise<Order | undefined> {
    try { return JSON.parse(await readFile(this.path(id), 'utf8')) as Order }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
  }
  async create(order: Order) {
    await mkdir(this.directory, { recursive: true })
    await writeFile(this.path(order.quote.id), JSON.stringify(order), { flag: 'wx', mode: 0o600 })
  }
  async submit(order: Order) {
    const existing = await this.read(order.quote.id)
    if (!existing || existing.userId !== order.userId) throw new InputError('Order belongs to another account.')
    if (existing.signature) return false
    const target = this.path(order.quote.id), temporary = target + '.' + randomUUID() + '.tmp'
    await writeFile(temporary, JSON.stringify({ ...existing, signature: order.signature, signed: order.signed }), { mode: 0o600 })
    await rename(temporary, target)
    return true
  }
}
export type OrderDocument = { orderId: string; ownerUid?: string; text: string; quote: NftDemoQuote;
  signature?: string; signed?: string; createdAt: Date; updatedAt: Date }
export class MongoOrderStore implements OrderStore {
  constructor(private readonly database: DatabaseProvider = mongoDatabase.get) {}
  private async orders() { return (await this.database()).collection<OrderDocument>('orders') }
  async read(id: string): Promise<Order | undefined> {
    const value = await (await this.orders()).findOne({ orderId: id })
    if (!value) return undefined
    return { userId: value.ownerUid, text: value.text, quote: value.quote, signature: value.signature, signed: value.signed }
  }
  async create(order: Order) {
    if (!order.userId) throw new InputError('Authenticated order owner is required')
    const now = new Date()
    // Insert-only: an existing order can never be reassigned or have its quote replaced.
    await (await this.orders()).insertOne({ orderId: order.quote.id, ownerUid: order.userId,
      text: order.text, quote: order.quote, createdAt: now, updatedAt: now })
  }
  async submit(order: Order) {
    if (!order.userId || !order.signature || !order.signed) throw new InputError('Invalid order submission')
    const result = await (await this.orders()).updateOne({ orderId: order.quote.id, ownerUid: order.userId,
      signature: { $exists: false } }, { $set: { signature: order.signature, signed: order.signed, updatedAt: new Date() } })
    return result.modifiedCount === 1
  }
}
