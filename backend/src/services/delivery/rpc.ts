import { Connection, type ConnectionConfig } from '@solana/web3.js'
import { solanaConfig } from '@gobuy/shared'

export class RpcUnavailable extends Error {
  constructor(readonly code: string) { super(code) }
}
export function retryableRpc(error: unknown) {
  return error instanceof RpcUnavailable || /429|too many requests|rate limit|RPC unavailable|timeout|timed out|fetch failed|ECONNRESET|503|502|504|Blockhash not found/i.test(error instanceof Error ? error.message : '')
}
export function positiveSetting(value: string | undefined, fallback: number) {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback
}
export const balanceCacheTtl = () => positiveSetting(process.env.SOLANA_RPC_BALANCE_CACHE_TTL_MS, 20000)

/** Shared HTTP gate. Reads share in-flight results, never submission responses or cached funds checks. */
export function rpcTransport(options: { concurrency?: number; fetch?: typeof fetch; sleep?: (ms: number) => Promise<void>; random?: () => number } = {}) {
  const fetcher = options.fetch ?? globalThis.fetch
  const sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)))
  const random = options.random ?? Math.random
  const limit = options.concurrency ?? positiveSetting(process.env.SOLANA_RPC_MAX_CONCURRENT, 3)
  let active = 0
  const waiting: (() => void)[] = []
  const pending = new Map<string, Promise<{ status: number; body: string }>>()
  const run = async (url: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1]) => {
    for (let retry = 0; ; retry++) {
      if (active >= limit) await new Promise<void>(resolve => waiting.push(resolve))
      else active++
      let delay = 0
      try {
        const response = await fetcher(url, { ...init, signal: AbortSignal.timeout(15000) })
        const body = await response.text()
        let code: number | undefined
        try { code = JSON.parse(body)?.error?.code } catch { /* Non-JSON gateway error. */ }
        const transient = [429, 502, 503, 504].includes(response.status) || code === 429 || code === -32005
        if (!transient) return { status: response.status, body }
        if (retry >= 4) throw new RpcUnavailable(response.status === 429 || code === 429 ? 'RPC_RATE_LIMIT' : 'RPC_UNAVAILABLE')
        const header = response.headers.get('retry-after')
        delay = header ? (/^\d+(\.\d+)?$/.test(header) ? Number(header) * 1000 : Date.parse(header) - Date.now()) : 0
        // Excessively long provider cooldowns are left to the persistent worker.
        if (delay > 60000) throw new RpcUnavailable('RPC_RATE_LIMIT')
      } catch (error) {
        if (error instanceof RpcUnavailable) throw error
        if (retry >= 4) throw new RpcUnavailable('RPC_UNAVAILABLE')
      } finally {
        const next = waiting.shift()
        if (next) next(); else active--
      }
      await sleep(delay > 0 ? delay : 2000 * 2 ** retry + Math.floor(random() * 500))
    }
  }
  return (async (url, init) => {
    let request: { id?: unknown; method?: string; params?: unknown } = {}
    try { request = JSON.parse(String(init?.body)) } catch { /* Do not deduplicate non-RPC traffic. */ }
    const key = request.method?.startsWith('get') ? JSON.stringify([String(url), request.method, request.params]) : undefined
    let task = key ? pending.get(key) : undefined
    if (!task) {
      task = run(url, init)
      if (key) { pending.set(key, task); void task.finally(() => pending.delete(key)).catch(() => {}) }
    }
    const result = await task
    let body = result.body
    try { const parsed = JSON.parse(body); parsed.id = request.id; body = JSON.stringify(parsed) } catch { /* Preserve HTTP error. */ }
    return new Response(body, { status: result.status, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
}
const sharedTransport = rpcTransport()
export function devnetRpc(rpcUrl = solanaConfig(process.env).rpcUrl) {
  return new Connection(rpcUrl, { commitment: 'confirmed', disableRetryOnRateLimit: true,
    fetch: sharedTransport as ConnectionConfig['fetch'] })
}
