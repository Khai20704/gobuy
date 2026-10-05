import { DEVNET_GENESIS } from '@gobuy/shared'

export type HeliusFailureCode = 'AUTH_FAILED' | 'RATE_LIMITED' | 'TIMEOUT' | 'NETWORK_ERROR' | 'INVALID_RESPONSE' | 'ASSET_NOT_FOUND'
export class HeliusError extends Error {
  constructor(readonly code: HeliusFailureCode) { super(`Helius: ${code}`) }
}
export function heliusRpcUrl(env: NodeJS.ProcessEnv = process.env) {
  if (env.HELIUS_NETWORK && env.HELIUS_NETWORK !== 'devnet') throw new Error('NETWORK_MISMATCH')
  const key = env.HELIUS_API_KEY?.trim()
  if (!key) throw new HeliusError('AUTH_FAILED')
  return `https://devnet.helius-rpc.com/?api-key=${encodeURIComponent(key)}`
}
export class HeliusClient {
  constructor(private readonly env: NodeJS.ProcessEnv = process.env, private readonly fetcher: typeof fetch = fetch,
    private readonly timeoutMs = 10000, private readonly network: 'devnet' | 'mainnet' = 'devnet') {}

  async call<T>(method: string, params: unknown, signal?: AbortSignal): Promise<T> {
    if (this.network === 'mainnet' && !['getAsset', 'getAssetsByGroup', 'getGenesisHash'].includes(method)) throw new Error('MAINNET_READ_ONLY')
    // Retry transient transport failures only for the read methods used here.
    // Never retry transaction submission or unknown RPC methods.
    const retryable = ['getGenesisHash', 'getAsset', 'getTokenAccountsByOwner', 'getAccountInfo'].includes(method)
    try { return await this.request<T>(method, params, signal) }
    catch (error) {
      if (!retryable || signal?.aborted || !(error instanceof HeliusError) || error.code !== 'NETWORK_ERROR') throw error
      return this.request<T>(method, params, signal)
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
      if (response.status === 401 || response.status === 403) throw new HeliusError('AUTH_FAILED')
      if (response.status === 429) throw new HeliusError('RATE_LIMITED')
      if (!response.ok) throw new HeliusError('NETWORK_ERROR')
      let body: { jsonrpc?: string; id?: string; result?: T; error?: { code?: number; message?: string } }
      try { body = await response.json() } catch { throw new HeliusError('INVALID_RESPONSE') }
      if (!body || body.jsonrpc !== '2.0' || body.id !== 'gobuy') throw new HeliusError('INVALID_RESPONSE')
      if (body.error) {
        const code = body.error.code
        throw new HeliusError(code === 429 ? 'RATE_LIMITED' : code === 401 || code === 403 ? 'AUTH_FAILED'
          : method === 'getAsset' && /asset.*not found/i.test(body.error.message ?? '') ? 'ASSET_NOT_FOUND' : 'INVALID_RESPONSE')
      }
      if (!('result' in body)) throw new HeliusError('INVALID_RESPONSE')
      return body.result as T
    } catch (error) {
      if (error instanceof HeliusError) throw error
      // Never attach transport causes: they can contain the credential-bearing URL.
      throw new HeliusError(abort.aborted ? 'TIMEOUT' : 'NETWORK_ERROR')
    }
  }
  async assertDevnet(signal?: AbortSignal) {
    if (await this.call<string>('getGenesisHash', [], signal) !== DEVNET_GENESIS) throw new Error('NETWORK_MISMATCH')
  }
}
