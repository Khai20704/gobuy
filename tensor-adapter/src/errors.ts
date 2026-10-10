/**
 * Typed failures for the Tensor Devnet adapter.
 *
 * Discovery must never turn an unavailable RPC into an empty, successfully verified market, so the
 * reason for a failed read is carried as a machine-readable category instead of a bare Error. That
 * lets the backend map each failure onto the right provider outcome (rate limit, timeout, transport
 * failure, unsupported method) instead of collapsing everything into one generic code.
 */
import type { TensorScanDiagnostics } from './types.js'

export type TensorFailureCategory =
  /** The caller's own deadline elapsed, or the RPC did not answer in time. */
  | 'TIMEOUT'
  /** Transport-level failure: connection reset, DNS, TLS, socket closed mid-flight. */
  | 'RPC_UNAVAILABLE'
  /** The endpoint answered with a non-success HTTP status that is not a rate limit. */
  | 'HTTP_ERROR'
  /** 429 or a JSON-RPC rate-limit code: the endpoint is throttling us. */
  | 'RATE_LIMITED'
  /** 401/403 or an invalid API key. */
  | 'AUTH_FAILED'
  /** The endpoint rejected the method itself (method not found / not supported). */
  | 'RPC_UNSUPPORTED'
  /** The endpoint answered, but the payload could not be decoded as the expected layout. */
  | 'INVALID_DATA'
  /** The endpoint is not Solana Devnet. The adapter never operates on another cluster. */
  | 'NETWORK_MISMATCH'

export type TensorErrorOptions = {
  httpStatus?: number
  rpcCode?: number
  /** Which deadline fired: our own read/scan budget or the caller's signal. */
  timeoutSource?: 'adapter' | 'caller'
  diagnostics?: readonly TensorScanDiagnostics[]
  cause?: unknown
}

export class TensorAdapterError extends Error {
  readonly category: TensorFailureCategory
  /**
   * The adapter operation that failed, e.g. `getProgramAccounts`.
   *
   * It is a constant identifier chosen by this package, never a URL or a response body, so it is safe
   * to log. It tells an operator which RPC step broke instead of only that "discovery failed".
   */
  readonly operation: string
  readonly httpStatus?: number
  readonly rpcCode?: number
  readonly timeoutSource?: 'adapter' | 'caller'
  readonly diagnostics: readonly TensorScanDiagnostics[]

  constructor(category: TensorFailureCategory, operation: string, options: TensorErrorOptions = {}) {
    // Only constant, non-sensitive data enters the message; RPC URLs and credentials never do.
    super(`Tensor adapter ${operation} failed: ${category}`)
    this.name = 'TensorAdapterError'
    this.category = category
    this.operation = operation
    this.httpStatus = options.httpStatus
    this.rpcCode = options.rpcCode
    this.timeoutSource = options.timeoutSource
    this.diagnostics = (options.diagnostics ?? []).map(step => ({ ...step }))
    if (options.cause !== undefined) this.cause = options.cause
  }
}

/** True when retrying an idempotent read could plausibly succeed. */
export function isRetryableTensorFailure(category: TensorFailureCategory) {
  return category === 'RPC_UNAVAILABLE' || category === 'TIMEOUT' || category === 'RATE_LIMITED'
}

/** Stable, log-safe name for a failure category. Never includes a URL or a raw exception. */
export function tensorFailureLabel(error: unknown) {
  return error instanceof TensorAdapterError ? error.category : 'UNKNOWN'
}

/**
 * Classifies an arbitrary RPC/transport failure. Only stable, documented numeric codes and the
 * standard transport error names are inspected: raw messages can embed the credential-bearing URL.
 */
export function classifyRpcFailure(error: unknown, signal?: AbortSignal, timeoutSource: 'adapter' | 'caller' = 'adapter') {
  if (error instanceof TensorAdapterError) return error
  const record = error as { name?: unknown; code?: unknown; status?: unknown; httpStatus?: unknown;
    context?: { statusCode?: unknown; __code?: unknown } } | null
  const name = typeof record?.name === 'string' ? record.name : ''
  const code = typeof record?.context?.__code === 'number' ? record.context.__code
    : typeof record?.code === 'number' ? record.code : undefined
  const httpStatus = typeof record?.httpStatus === 'number' ? record.httpStatus
    : typeof record?.status === 'number' ? record.status
      : typeof record?.context?.statusCode === 'number' ? record.context.statusCode : undefined
  const cause = (error as { cause?: { code?: unknown } } | null)?.cause
  const transportCode = typeof cause?.code === 'string' ? cause.code : undefined

  if (signal?.aborted) return new TensorAdapterError('TIMEOUT', 'read', { timeoutSource, cause: error })
  if (name === 'TimeoutError' || name === 'AbortError') {
    return new TensorAdapterError('TIMEOUT', 'read', { timeoutSource, cause: error })
  }
  if (httpStatus === 401 || httpStatus === 403) return new TensorAdapterError('AUTH_FAILED', 'read', { httpStatus, cause: error })
  if (httpStatus === 429) return new TensorAdapterError('RATE_LIMITED', 'read', { httpStatus, cause: error })
  if (httpStatus !== undefined && httpStatus >= 400) return new TensorAdapterError('HTTP_ERROR', 'read', { httpStatus, cause: error })
  if (code === -32601) return new TensorAdapterError('RPC_UNSUPPORTED', 'read', { rpcCode: code })
  // Invalid parameters and Solana server errors are not evidence of bad credentials.
  if (code === -32602) return new TensorAdapterError('INVALID_DATA', 'read', { rpcCode: code })
  if (code === 429) return new TensorAdapterError('RATE_LIMITED', 'read', { rpcCode: code, cause: error })
  // Standard Node transport failures: ECONNRESET, ECONNREFUSED, ETIMEDOUT, ENOTFOUND, EAI_AGAIN,
  // UND_ERR_SOCKET, and undici "fetch failed" all land here.
  if (transportCode || name === 'TypeError' || /fetch failed/i.test(typeof record?.code === 'string' ? record.code : '')) {
    return new TensorAdapterError('RPC_UNAVAILABLE', 'read', { cause: error })
  }
  return new TensorAdapterError('RPC_UNAVAILABLE', 'read', { rpcCode: code, cause: error })
}

/** Retries an idempotent read-only operation with jittered exponential backoff. */
export async function withReadRetry<T>(
  operation: string,
  run: () => Promise<T>,
  options: { attempts?: number; baseDelayMs?: number; signal?: AbortSignal; sleep?: (ms: number) => Promise<void> } = {},
): Promise<T> {
  const attempts = options.attempts ?? 3
  const baseDelayMs = options.baseDelayMs ?? 250
  const sleep = options.sleep ?? (ms => new Promise<void>((resolve, reject) => {
    const signal = options.signal
    if (signal?.aborted) { reject(signal.reason); return }
    const finish = () => { signal?.removeEventListener('abort', abort); resolve() }
    const timer = setTimeout(finish, ms)
    const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(signal?.reason) }
    signal?.addEventListener('abort', abort, { once: true })
  }))
  for (let attempt = 1; ; attempt++) {
    try {
      return await run()
    } catch (error) {
      const failure = error instanceof TensorAdapterError ? error : classifyRpcFailure(error, options.signal)
      // A caller-requested abort is definitive: never retry it, and never mask it as a provider fault.
      if (failure.timeoutSource === 'caller' || options.signal?.aborted) throw failure
      if (attempt >= attempts || !isRetryableTensorFailure(failure.category)) throw failure
      void operation
      await sleep(baseDelayMs * 2 ** (attempt - 1) + Math.floor(Math.random() * 100))
    }
  }
}
