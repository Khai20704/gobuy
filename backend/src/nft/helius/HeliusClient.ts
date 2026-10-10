import { DEVNET_GENESIS } from '@gobuy/shared'

export type HeliusFailureCode = 'AUTH_FAILED' | 'RATE_LIMITED' | 'TIMEOUT' | 'NETWORK_ERROR'
  | 'RPC_UNSUPPORTED' | 'INVALID_RESPONSE' | 'ASSET_NOT_FOUND'

/** Methods whose failures are always transport/endpoint faults worth one more read-only attempt. */
const RETRYABLE_READ_METHODS = new Set(['getGenesisHash', 'getAsset', 'getAssetsByGroup', 'getTokenAccountsByOwner', 'getAccountInfo'])
const RETRYABLE_CODES = new Set<HeliusFailureCode>(['NETWORK_ERROR', 'RATE_LIMITED', 'TIMEOUT'])
const READ_RETRY_ATTEMPTS = 3
const RETRY_BASE_DELAY_MS = 200
/**
 * Hard ceiling on time spent retrying one call.
 *
 * Discovery runs this client per candidate inside a shared provider deadline, so an unbounded retry
 * loop could starve the whole search. Retries stop as soon as this budget is spent, whatever the
 * configured per-attempt timeout is.
 */
const RETRY_BUDGET_MS = 8_000

export class HeliusError extends Error {
  /** HTTP status when the failure came from the transport layer, never the URL or credentials. */
  readonly httpStatus?: number
  readonly rpcCode?: number
  readonly timeoutSource?: 'client' | 'caller'
  readonly attempts?: number

  constructor(readonly code: HeliusFailureCode, detail: {
    httpStatus?: number; rpcCode?: number; timeoutSource?: 'client' | 'caller'; attempts?: number
  } = {}) {
    super(`Helius: ${code}`)
    this.name = 'HeliusError'
    this.httpStatus = detail.httpStatus
    this.rpcCode = detail.rpcCode
    this.timeoutSource = detail.timeoutSource
    this.attempts = detail.attempts
  }
}

export function heliusRpcUrl(env: NodeJS.ProcessEnv = process.env) {
  if (env.HELIUS_NETWORK && env.HELIUS_NETWORK !== 'devnet') throw new Error('NETWORK_MISMATCH')
  const key = env.HELIUS_API_KEY?.trim()
  if (!key) throw new HeliusError('AUTH_FAILED')
  return `https://devnet.helius-rpc.com/?api-key=${encodeURIComponent(key)}`
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

export class HeliusClient {
  private devnetChecked?: Promise<void>

  constructor(private readonly env: NodeJS.ProcessEnv = process.env, private readonly fetcher: typeof fetch = fetch,
    private readonly timeoutMs = 10000, private readonly network: 'devnet' | 'mainnet' = 'devnet') {}

  async call<T>(method: string, params: unknown, signal?: AbortSignal): Promise<T> {
    if (this.network === 'mainnet' && !['getAsset', 'getAssetsByGroup', 'getGenesisHash'].includes(method)) throw new Error('MAINNET_READ_ONLY')
    // Retry transient transport failures only for the read methods used here.
    // Never retry transaction submission or unknown RPC methods.
    const startedAt = Date.now()
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.request<T>(method, params, signal)
      } catch (error) {
        // A caller-imposed abort is definitive and is always reported as the caller's timeout.
        if (signal?.aborted) throw error
        if (!(error instanceof HeliusError) || !RETRYABLE_READ_METHODS.has(method)) throw error
        if (!RETRYABLE_CODES.has(error.code)) throw error
        if (attempt >= READ_RETRY_ATTEMPTS || Date.now() - startedAt >= RETRY_BUDGET_MS) throw error
        const delay = RETRY_BASE_DELAY_MS * 2 ** (attempt - 1) + Math.floor(Math.random() * 100)
        if (Date.now() - startedAt + delay >= RETRY_BUDGET_MS) throw error
        await sleep(delay)
      }
    }
  }

  private async request<T>(method: string, params: unknown, signal?: AbortSignal): Promise<T> {
    const key = (this.env.HELIUS_MAINNET_API_KEY || this.env.HELIUS_API_KEY)?.trim()
    if (this.network === 'mainnet' && !key) throw new HeliusError('AUTH_FAILED')
    const url = this.network === 'mainnet' ? `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(key!)}` : heliusRpcUrl(this.env)
    const timeout = AbortSignal.timeout(this.timeoutMs)
    const abort = signal ? AbortSignal.any([timeout, signal]) : timeout
    try {
      const response = await this.fetcher(url, { method: 'POST', redirect: 'error', signal: abort,
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 'gobuy', method, params }) })
      if (response.status === 401 || response.status === 403) throw new HeliusError('AUTH_FAILED', { httpStatus: response.status })
      if (response.status === 429) throw new HeliusError('RATE_LIMITED', { httpStatus: response.status })
      if (!response.ok) throw new HeliusError('NETWORK_ERROR', { httpStatus: response.status })
      let body: { jsonrpc?: string; id?: string; result?: T; error?: { code?: number; message?: string } }
      try { body = await response.json() } catch { throw new HeliusError('INVALID_RESPONSE', { httpStatus: response.status }) }
      if (!body || body.jsonrpc !== '2.0' || body.id !== 'gobuy') throw new HeliusError('INVALID_RESPONSE', { httpStatus: response.status })
      if (body.error) {
        const code = body.error.code
        throw new HeliusError(code === 429 || code === -32005 ? 'RATE_LIMITED'
          : code === 401 || code === 403 ? 'AUTH_FAILED'
            : code === -32601 || code === -32602 ? 'RPC_UNSUPPORTED'
              : method === 'getAsset' && /asset.*not found/i.test(body.error.message ?? '') ? 'ASSET_NOT_FOUND' : 'INVALID_RESPONSE',
        { rpcCode: code, httpStatus: response.status })
      }
      if (!('result' in body)) throw new HeliusError('INVALID_RESPONSE', { httpStatus: response.status })
      return body.result as T
    } catch (error) {
      if (error instanceof HeliusError) throw error
      // Never attach transport causes: they can contain the credential-bearing URL.
      // Distinguish a deadline we imposed from the caller's own cancellation.
      if (signal?.aborted) throw new HeliusError('TIMEOUT', { timeoutSource: 'caller' })
      throw new HeliusError(abort.aborted ? 'TIMEOUT' : 'NETWORK_ERROR',
        { timeoutSource: abort.aborted ? 'client' : undefined })
    }
  }

  /**
   * Confirms the RPC really is Devnet.
   *
   * The result is cached for the lifetime of this client: the genesis hash of a network is immutable,
   * and re-reading it for every asset made ownership verification several times more expensive than
   * the reads it was guarding. A failed check is never cached.
   */
  async assertDevnet(signal?: AbortSignal) {
    if (signal?.aborted) throw new HeliusError('TIMEOUT', { timeoutSource: 'caller' })
    if (!this.devnetChecked) {
      const pending = this.call<string>('getGenesisHash', []).then(genesis => {
        if (genesis !== DEVNET_GENESIS) throw new Error('NETWORK_MISMATCH')
      }).catch(error => {
        this.devnetChecked = undefined
        throw error
      })
      this.devnetChecked = pending
    }
    return this.devnetChecked
  }
}
