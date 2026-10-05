import { z } from 'zod'
import type { LLMProvider, LLMRequest } from '../LLMProvider.js'
import { requestMessages } from '../context.js'
import { ProviderFailure } from '../errors/classifyProviderError.js'
import { parseResponse, providerJson, type Fetcher } from './http.js'

const responseSchema = z.object({ stop_reason: z.string(), content: z.array(z.object({ type: z.string(), text: z.string().optional() })) })
export class AnthropicProvider implements LLMProvider {
  readonly name = 'anthropic'
  constructor(private readonly key?: string, readonly model = 'claude-sonnet-4-5', private readonly fetcher: Fetcher = fetch,
    readonly contextWindowTokens = 200000) {}
  isConfigured() { return !!this.key?.trim() && !!this.model }
  async generate(request: LLMRequest, signal: AbortSignal) {
    const started = Date.now(), messages = requestMessages(request)
    const system = messages.filter(m => m.role === 'system').map(m => m.content).join('\n')
      + (request.responseFormat === 'json' ? '\nReturn only JSON matching this schema: ' + JSON.stringify(request.jsonSchema?.schema ?? {}) : '')
    const result = parseResponse(responseSchema, await providerJson('https://api.anthropic.com/v1/messages', {
      method: 'POST', signal, headers: { 'x-api-key': this.key ?? '', 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.model, system, max_tokens: request.maxTokens ?? 1600,
        messages: messages.filter(m => m.role !== 'system').map(({ role, content }) => ({ role, content })),
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}) }),
    }, this.fetcher))
    if (result.stop_reason === 'refusal') throw new ProviderFailure('refusal')
    if (result.stop_reason !== 'end_turn') throw new ProviderFailure('invalid_output')
    const content = result.content.filter(p => p.type === 'text').map(p => p.text ?? '').join('')
    if (!content.trim()) throw new ProviderFailure('invalid_output')
    return { content, provider: this.name, model: this.model, latencyMs: Date.now() - started }
  }
}
