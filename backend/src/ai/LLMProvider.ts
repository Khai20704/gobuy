export interface LLMMessage {
  role: 'user' | 'assistant' | 'system'
  content: string
  // Only redundant, non-critical history may be dropped. Default is to retain it.
  discardable?: boolean
}

export interface LLMRequest {
  operation?: string
  systemPrompt?: string
  messages: LLMMessage[]
  protectedContext?: Record<string, unknown>
  temperature?: number
  maxTokens?: number
  responseFormat?: 'text' | 'json'
  jsonSchema?: { name: string; schema: Record<string, unknown> }
  validate?: (value: unknown) => unknown
  totalTimeoutMs?: number
}

export interface LLMResponse {
  content: string
  provider: string
  model: string
  latencyMs: number
  failoverCount?: number
}

export interface LLMProvider {
  readonly name: string
  readonly model: string
  readonly contextWindowTokens?: number
  isConfigured(): boolean
  // Optional cheap reachability probe; it must never generate text or spend tokens.
  checkAvailability?(signal: AbortSignal): Promise<boolean>
  generate(request: LLMRequest, signal: AbortSignal): Promise<LLMResponse>
}
