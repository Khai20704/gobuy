export type ProviderErrorCategory = 'quota' | 'rate_limit' | 'timeout' | 'unavailable' | 'connection'
  | 'credentials' | 'model_unavailable' | 'context_length' | 'invalid_output' | 'invalid_request' | 'refusal'

// Created only at the provider boundary. Application/authorization errors must never be wrapped in this.
export class ProviderFailure extends Error {
  constructor(readonly category: ProviderErrorCategory, readonly status?: number) {
    super(`AI provider request failed (${category}).`)
  }
}

export function classifyProviderError(error: unknown): ProviderErrorCategory | 'application' {
  return error instanceof ProviderFailure ? error.category : 'application'
}

export function providerHttpFailure(status: number, body: unknown): ProviderFailure {
  const value = body && typeof body === 'object' ? body as Record<string, unknown> : {}
  const detail = value.error && typeof value.error === 'object' ? value.error as Record<string, unknown> : value
  // Inspect transiently; never retain or log response bodies, messages, headers, or credentials.
  const code = typeof detail.code === 'string' ? detail.code : typeof detail.type === 'string' ? detail.type : typeof detail.status === 'string' ? detail.status : ''
  const message = typeof detail.message === 'string' ? detail.message : typeof value.error === 'string' ? value.error : ''
  const text = `${code} ${message}`.slice(0, 8000).toLowerCase()
  if (/insufficient_quota|quota_exceeded|billing_hard_limit|quota exhausted|credit[ _]balance|billing_error/.test(text)) return new ProviderFailure('quota', status)
  if (status === 429) return new ProviderFailure('rate_limit', status)
  if ([400, 413, 422].includes(status) && /context_length_exceeded|context window|context length|maximum context|input.*token.*(?:exceed|limit)|prompt.*(?:too long|too large)/.test(text)) return new ProviderFailure('context_length', status)
  if (status === 401 || status === 403) return new ProviderFailure('credentials', status)
  if (status === 408 || status === 504) return new ProviderFailure('timeout', status)
  if (status >= 500) return new ProviderFailure('unavailable', status)
  // Gemini may identify a missing model only through its structured status.
  if (status === 404 && code === 'NOT_FOUND') return new ProviderFailure('model_unavailable', status)
  if ((status === 404 || status === 400) && /model.*(?:not found|does not exist|unavailable|decommissioned|not supported)|model_not_found/.test(text)) return new ProviderFailure('model_unavailable', status)
  if (status === 400 && /json_validate_failed/.test(text)) return new ProviderFailure('invalid_output', status)
  return new ProviderFailure('invalid_request', status)
}

export class LLMUnavailableError extends Error {
  readonly code = 'ALL_LLM_PROVIDERS_UNAVAILABLE'
  readonly retryable = true
  constructor() { super("Na's AI providers are temporarily unavailable. Please try again shortly.") }
}
export class LLMContextError extends Error {
  readonly code = 'LLM_CONTEXT_TOO_LARGE'
  readonly retryable = false
  constructor() { super('Na cannot safely fit this conversation into the available models. Start a shorter request with the product, budget and requirements.') }
}
export class LLMRefusalError extends Error {
  readonly code = 'LLM_REQUEST_REFUSED'
  readonly retryable = false
  constructor() { super('Na could not process this request. Please rephrase your shopping requirements.') }
}
