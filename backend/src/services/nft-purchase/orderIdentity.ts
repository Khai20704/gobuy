import { createHash } from 'node:crypto'

/**
 * Stable order identity for a genuine purchase.
 *
 * The id is derived only from the immutable discovery id, never from the price, seller or time, so
 * retrying the same request always resolves to the same order and therefore the same on-chain
 * receipt PDA. That PDA is the replay guard: the program creates it with `init`, so the same order
 * can never settle twice. The id is 16 bytes because that is what the receipt seeds carry.
 */
export const ORDER_ID_BYTES = 16

export function orderIdFor(discoveryId: string): Buffer {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(discoveryId)) {
    throw new Error('A discovery UUID is required to derive a stable order id.')
  }
  return createHash('sha256').update('gobuy:nft-order:' + discoveryId).digest().subarray(0, ORDER_ID_BYTES)
}

export function orderIdHex(discoveryId: string): string {
  return orderIdFor(discoveryId).toString('hex')
}

/** True only for a well-formed, non-zero 16-byte order id. */
export function isValidOrderIdHex(value: string): boolean {
  return /^[0-9a-f]{32}$/.test(value) && value !== '0'.repeat(32)
}
