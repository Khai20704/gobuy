import type { TensorFailureCategory } from './errors.js'

export type TensorListing = {
  listState: string
  mint: string
  seller: string
  priceLamports: string
  expiry: string
  name: string
  symbol: string
}

/**
 * One structured record per logical RPC operation performed while scanning.
 *
 * Deliberately carries no URLs, headers, tokens or raw exception objects: only operation names,
 * timings, counts and constant failure categories, so it is always safe to log.
 */
export type TensorScanDiagnostics = {
  operation: 'getGenesisHash' | 'getProgramAccounts' | 'decode' | 'metadata' | 'mintAccounts'
  durationMs: number
  accountsRead: number
  httpStatus?: number
  category?: TensorFailureCategory
  timeoutSource?: 'adapter' | 'caller'
}

export type TensorScanResult = {
  listings: TensorListing[]
  /** Every account the RPC returned for the ListState discriminator, before any filtering. */
  scanned: number
  /** Accounts that decoded as a public, non-expired, SOL-priced listing inside the budget. */
  activeSolListings: number
  metadataMissing: number
  unsupportedStandards: number
  /** Present when the adapter ran the scan; omitted by injected test doubles. */
  diagnostics?: TensorScanDiagnostics[]
}

export type TensorBuyInstruction = {
  programAddress: string
  accounts: { address: string; isSigner: boolean; isWritable: boolean }[]
  data: Uint8Array
  mint: string
  seller: string
  listState: string
  priceLamports: string
}

export type TensorReadOptions = {
  /** Caller deadline; may end the complete adapter call earlier. */
  signal?: AbortSignal
  /** Total adapter call budget, including all phases and retries. */
  timeoutMs?: number
}
