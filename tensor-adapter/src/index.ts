/**
 * Tensor Marketplace Devnet adapter.
 *
 * Responsibilities are split so each concern is testable on its own:
 *   - `errors`      typed, log-safe failure categories and read retries
 *   - `rpc`         Devnet-only RPC construction, timeouts and ListState predicates
 *   - `scan`        full-program ListState discovery with diagnostics
 *   - `listing`     single-listing reads by mint or by ListState address
 *   - `buy`         BuyLegacy instruction construction for a buyer and payer
 *
 * The adapter never falls back to a mock catalogue, never fabricates a listing and never permits a
 * non-Devnet cluster.
 */
export { TensorAdapterError, classifyRpcFailure, isRetryableTensorFailure, tensorFailureLabel, withReadRetry } from './errors.js'
export type { TensorErrorOptions, TensorFailureCategory } from './errors.js'
export { chunk, mapWithConcurrency } from './concurrency.js'
export {
  ACCOUNT_BATCH_SIZE,
  BATCH_CONCURRENCY,
  DEFAULT_OPERATION_TIMEOUT_MS,
  DEVNET_GENESIS,
  TOKEN_PROGRAM,
  publiclyBuyable,
  scopeSignal,
  supportedTokenStandard,
} from './rpc.js'
export { scanTensorDevnetListings } from './scan.js'
export { fetchTensorDevnetListing, fetchTensorDevnetListingById } from './listing.js'
export { buildTensorLegacyBuyInstruction } from './buy.js'
export type {
  TensorBuyInstruction,
  TensorListing,
  TensorReadOptions,
  TensorScanDiagnostics,
  TensorScanResult,
} from './types.js'
export { TENSOR_MARKETPLACE_PROGRAM_ADDRESS as tensorMarketplaceProgram } from '@tensor-foundation/marketplace'
