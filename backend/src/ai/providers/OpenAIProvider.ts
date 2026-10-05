import { z } from 'zod'
import type { LLMProvider, LLMRequest } from '../LLMProvider.js'
import { requestMessages } from '../context.js'
import { ProviderFailure } from '../errors/classifyProviderError.js'
import { parseResponse, providerJson, type Fetcher } from './http.js'

const responseSchema = z.object({ status: z.string(), output: z.array(z.object({
  type: z.string(), content: z.array(z.object({ type: z.string(), text: z.string().optional() })).optional(),
})) })
export class OpenAIProvider implements LLMProvider {
  readonly name = 'openai'
  readonly contextWindowTokens?: number
  constructor(private readonly key?: string, readonly model = 'gpt-4o-mini', private readonly fetcher: Fetcher = fetch, contextWindowTokens?: number) {
    this.contextWindowTokens = contextWindowTokens ?? (model === 'gpt-4o-mini' ? 128000 : undefined)
  }
  isConfigured() { return !!this.key?.trim() && !!this.model }
  async generate(request: LLMRequest, signal: AbortSignal) {
    const start = Date.now(), messages = requestMessages(request)
    const output = parseResponse(responseSchema, await providerJson('https://api.openai.com/v1/responses', {
      method: 'POST', signal, headers: { Authorization: `Bearer ${this.key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.model, store: false,
        instructions: messages.filter(message => message.role === 'system').map(message => message.content).join('\n'),
        input: messages.filter(message => message.role !== 'system'), max_output_tokens: request.maxTokens ?? 1600,
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
        ...(request.responseFormat === 'json' ? { text: { format: request.jsonSchema
          ? { type: 'json_schema', name: request.jsonSchema.name, strict: true, schema: request.jsonSchema.schema } : { type: 'json_object' } } } : {}),
      }),
    }, this.fetcher))
    const parts = output.output.flatMap(item => item.type === 'message' ? item.content ?? [] : [])
    if (parts.some(part => part.type === 'refusal')) throw new ProviderFailure('refusal')
    if (output.status !== 'completed') throw new ProviderFailure('invalid_output')
    const content = parts.filter(part => part.type === 'output_text').map(part => part.text ?? '').join('')
    if (!content.trim()) throw new ProviderFailure('invalid_output')
    return { content, provider: this.name, model: this.model, latencyMs: Date.now() - start }
  }
}
