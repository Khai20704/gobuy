import { isPublicHttpsUrl } from '@gobuy/shared'

export type Fetcher = typeof fetch
export type ProviderFailureCode = 'AUTHENTICATION_FAILED' | 'ACCESS_FORBIDDEN' | 'RATE_LIMITED'
  | 'PROVIDER_UNAVAILABLE' | 'INVALID_RESPONSE' | 'RESPONSE_TOO_LARGE' | 'TIMEOUT' | 'NO_DATA'
  | 'DISABLED' | 'AUTH_REQUIRED' | 'NETWORK_ERROR' | 'SCHEMA_MISMATCH' | 'NO_MATCH'

const providerFailureMessages: Record<ProviderFailureCode, string> = {
  DISABLED: 'Provider is disabled.', AUTH_REQUIRED: 'This capability requires an API key.',
  NETWORK_ERROR: 'Provider connection failed.', SCHEMA_MISMATCH: 'Provider rows do not match the supported schema.',
  NO_MATCH: 'No matching listings in the checked data.',
  AUTHENTICATION_FAILED: 'Provider rejected API credentials.',
  ACCESS_FORBIDDEN: 'Provider denied access to this endpoint.',
  RATE_LIMITED: 'Provider rate limit reached.',
  PROVIDER_UNAVAILABLE: 'External provider is temporarily unavailable.',
  INVALID_RESPONSE: 'Provider returned an invalid response.',
  RESPONSE_TOO_LARGE: 'Provider response is too large; the allowed-size limit was exceeded.',
  TIMEOUT: 'Provider request timed out.',
  NO_DATA: 'Provider returned no usable market data.',
}

export function providerFailureCode(status?: number): ProviderFailureCode {
  if (status === 401) return 'AUTHENTICATION_FAILED'
  if (status === 403) return 'ACCESS_FORBIDDEN'
  if (status === 429) return 'RATE_LIMITED'
  if (status !== undefined && status >= 500) return 'PROVIDER_UNAVAILABLE'
  return 'INVALID_RESPONSE'
}

export class ProviderRequestError extends Error {
  readonly code: ProviderFailureCode
  constructor(readonly status?: number, code = providerFailureCode(status)) {
    super(providerFailureMessages[code])
    this.name = 'ProviderRequestError'
    this.code = code
  }
}
// Endpoints come from adapter code, never from user/model output. No redirects or scraping.
export async function fetchJson(url: URL | string, init: RequestInit, fetcher: Fetcher = fetch): Promise<unknown> {
  let response: Response
  try { response = await fetcher(url, { ...init, redirect: 'error' }) }
  catch (error) {
    if (init.signal?.aborted || error instanceof Error && error.name === 'AbortError') throw new ProviderRequestError(undefined, 'TIMEOUT')
    throw new ProviderRequestError(undefined, 'NETWORK_ERROR')
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {})
    throw new ProviderRequestError(response.status)
  }
  if (!response.headers.get('content-type')?.toLowerCase().includes('json')) throw new ProviderRequestError(undefined, 'INVALID_RESPONSE')
  if (Number(response.headers.get('content-length')) > 2_000_000) throw new ProviderRequestError(undefined, 'RESPONSE_TOO_LARGE')
  const reader = response.body?.getReader()
  if (!reader) throw new ProviderRequestError(undefined, 'NO_DATA')
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.length
      if (size > 2_000_000) throw new ProviderRequestError(undefined, 'RESPONSE_TOO_LARGE')
      chunks.push(chunk.value)
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown }
    catch { throw new ProviderRequestError(undefined, 'INVALID_RESPONSE') }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
}
export const safeImage = (url?: string) => url && isPublicHttpsUrl(url) ? url : undefined
export const plainText = (value: string, length = 300) => value.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim().slice(0, length)
