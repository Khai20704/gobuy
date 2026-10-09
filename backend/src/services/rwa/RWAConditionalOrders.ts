import { createHash, randomUUID } from 'node:crypto'
import { rwaOrderSchema, type RWAIntent, type RWAOrder, type RWAOrderStatus, type RWAAsset } from '@gobuy/shared'
import { assetStore, type AssetStore } from '../../persistence/AssetStore.js'
import { InputError } from '../../schemas/search.js'

/**
 * Persistence for conditional RWA orders.
 *
 * An unmet market condition is a WAITING state, never a rejection: the order is stored, re-checked
 * later, and executed at most once. Persistence reuses `AssetStore`, so MongoDB is used in
 * production and the file store in tests, with the same `$setOnInsert` guard as every other order.
 */

export const RWA_CONDITIONAL_ORDERS_STORE = 'rwaConditionalOrders'
const DEFAULT_TTL_MS = 7 * 86_400_000

/** Terminal states never block a fresh request and are never executed twice. */
const TERMINAL: ReadonlySet<RWAOrderStatus> = new Set(['CONFIRMED', 'FAILED', 'EXPIRED', 'CANCELLED', 'EXECUTION_UNAVAILABLE'])
export const isTerminalStatus = (status: RWAOrderStatus) => TERMINAL.has(status)

/** Atomic units for a user-stated quantity, using the resolved mint's decimals. */
export function quantityUnits(quantity: string, decimals: number): string {
  const [whole, fraction = ''] = quantity.split('.')
  if (fraction.length > decimals) throw new InputError(`Asset này có tối đa ${decimals} chữ số thập phân.`)
  return (BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0'))).toString()
}

export class RWAConditionalOrders {
  constructor(private readonly orders: AssetStore<RWAOrder> = assetStore<RWAOrder>(RWA_CONDITIONAL_ORDERS_STORE),
    private readonly ttlMs = DEFAULT_TTL_MS) {}

  /** Deterministic: the same instruction for the same owner, mint and trigger is ONE order. */
  idempotencyKey(input: { owner: string; asset: RWAAsset; intent: RWAIntent }): string {
    return createHash('sha256').update([input.owner, input.asset.mint, input.intent.order ?? 'SPEND',
      input.intent.amount ?? '-', input.intent.quantity ?? '-', input.intent.condition?.targetPrice ?? '-',
      input.intent.maxTotalSpend ?? '-'].join('|')).digest('hex').slice(0, 40)
  }

  async create(input: { userId: string; owner: string; asset: RWAAsset; intent: RWAIntent; mandate?: string | null }): Promise<{ order: RWAOrder; duplicate: boolean }> {
    const key = this.idempotencyKey(input)
    const open = (await this.orders.list(input.userId, 200)).find(order => order.idempotencyKey === key && !isTerminalStatus(order.status))
    if (open) return { order: open, duplicate: true }
    const now = new Date()
    const quantity = input.intent.order === 'QUANTITY' && input.intent.quantity
      ? quantityUnits(input.intent.quantity, input.asset.decimals!) : undefined
    const order = rwaOrderSchema.parse({
      id: randomUUID(), owner: input.owner, assetMint: input.asset.mint, symbol: input.asset.symbol,
      orderType: input.intent.order ?? 'SPEND',
      spendAmount: quantity ? undefined : input.intent.amount,
      spendCurrency: quantity ? undefined : input.intent.currency,
      quantity,
      maxTotalSpend: quantity ? input.intent.maxTotalSpend : undefined,
      maxSpendCurrency: quantity ? input.intent.maxSpendCurrency : undefined,
      condition: input.intent.condition,
      // A conditional order waits. One without a trigger has nothing to wait for, and this build has
      // no on-chain execution path, so it reports execution as unavailable rather than pretending.
      status: input.intent.condition ? 'WAITING_FOR_PRICE' : 'EXECUTION_UNAVAILABLE',
      mandate: input.mandate ?? null,
      idempotencyKey: key,
      createdAt: now.toISOString(), updatedAt: now.toISOString(), expiresAt: new Date(now.getTime() + this.ttlMs).toISOString(),
    })
    await this.orders.put(input.userId, order.id, order, true)
    return { order, duplicate: false }
  }

  async find(userId: string, id: string): Promise<RWAOrder> {
    const order = await this.orders.get(userId, id)
    if (!order) throw new InputError('Không tìm thấy lệnh RWA có điều kiện của tài khoản này.')
    return order
  }

  async list(userId: string, limit = 50): Promise<RWAOrder[]> {
    return (await this.orders.list(userId, limit)).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  async update(userId: string, order: RWAOrder,
    patch: { status?: RWAOrderStatus; observation?: RWAOrder['observation']; execution?: RWAOrder['execution']; mandate?: string | null }): Promise<RWAOrder> {
    const next = rwaOrderSchema.parse({ ...order, ...patch, updatedAt: new Date().toISOString() })
    await this.orders.put(userId, next.id, next)
    return next
  }

  /** Price gate. Returns null when there is no condition or no trustworthy observation. */
  conditionMet(order: RWAOrder, observedPrice: number | null): boolean | null {
    if (!order.condition) return null
    if (observedPrice === null || !Number.isFinite(observedPrice)) return null
    return observedPrice < order.condition.targetPrice
  }

  expired(order: RWAOrder, now = Date.now()) { return Date.parse(order.expiresAt) <= now }
}
