import { z } from 'zod'
import type { LLMProvider, LLMRequest } from '../LLMProvider.js'
import { requestMessages } from '../context.js'
import { ProviderFailure } from '../errors/classifyProviderError.js'
import { parseResponse, providerJson, type Fetcher } from './http.js'

export class OllamaProvider implements LLMProvider {
  readonly name = 'ollama'
  constructor(private readonly baseUrl = 'http://localhost:11434', readonly model = '', private readonly fetcher: Fetcher = fetch,
    readonly contextWindowTokens = 8192, private readonly probeTimeoutMs = 1000) {}
  isConfigured() { return !!this.model.trim() }
  async checkAvailability(signal: AbortSignal) {
    try {
      const body = parseResponse(z.object({ models: z.array(z.object({ name: z.string() })) }),
        await providerJson(`${this.baseUrl.replace(/\/$/, '')}/api/tags`, { signal: AbortSignal.any([signal, AbortSignal.timeout(this.probeTimeoutMs)]) }, this.fetcher))
      const name = this.model.includes(':') ? this.model : `${this.model}:latest`
      return body.models.some(model => model.name === this.model || model.name === name)
    } catch { return false }
  }
  async generate(request: LLMRequest, signal: AbortSignal) {
    const start = Date.now()
    const messages = requestMessages(request)
    // Conservative byte bound prevents Ollama from silently truncating retained constraints.
    // This may reject prompts that a model-specific tokenizer could fit, but never drops state.
    if (Buffer.byteLength(JSON.stringify(messages), 'utf8') + (request.maxTokens ?? 1600) + 128 > this.contextWindowTokens) throw new ProviderFailure('context_length')
    const body = parseResponse(z.object({ done: z.literal(true), done_reason: z.string().optional(), message: z.object({ content: z.string().min(1) }) }),
      await providerJson(`${this.baseUrl.replace(/\/$/, '')}/api/chat`, {
        method: 'POST', signal, headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: this.model, messages, stream: false,
          ...(request.responseFormat === 'json' ? { format: request.jsonSchema?.schema ?? 'json' } : {}),
          options: { num_predict: request.maxTokens ?? 1600, num_ctx: this.contextWindowTokens,
            ...(request.temperature !== undefined ? { temperature: request.temperature } : {}) },
        }),
      }, this.fetcher))
    if (body.done_reason === 'length') throw new ProviderFailure('invalid_output')
    return { content: body.message.content, provider: this.name, model: this.model, latencyMs: Date.now() - start }
  }
}
