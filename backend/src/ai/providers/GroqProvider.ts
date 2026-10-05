import { z } from 'zod'
import type { LLMProvider, LLMRequest } from '../LLMProvider.js'
import { requestMessages } from '../context.js'
import { ProviderFailure } from '../errors/classifyProviderError.js'
import { parseResponse, providerJson, type Fetcher } from './http.js'

const responseSchema = z.object({ choices: z.array(z.object({ finish_reason: z.string(),
  message: z.object({ content: z.string().nullable(), refusal: z.string().nullish() }),
})).min(1) })
export class GroqProvider implements LLMProvider {
  readonly name = 'groq'
  readonly contextWindowTokens?: number
  constructor(private readonly key?: string, readonly model = 'llama-3.3-70b-versatile', private readonly fetcher: Fetcher = fetch, contextWindowTokens?: number) {
    this.contextWindowTokens = contextWindowTokens ?? (model === 'llama-3.3-70b-versatile' ? 131072 : undefined)
  }
  isConfigured() { return !!this.key?.trim() && !!this.model }
  async generate(request: LLMRequest, signal: AbortSignal) {
    const start = Date.now()
    const output = parseResponse(responseSchema, await providerJson('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST', signal, headers: { Authorization: `Bearer ${this.key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.model, messages: requestMessages(request), stream: false,
        max_completion_tokens: request.maxTokens ?? 1600,
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
        // JSON mode works with the default model; schema enforcement stays in the router.
        ...(request.responseFormat === 'json' ? { response_format: { type: 'json_object' } } : {}),
      }),
    }, this.fetcher))
    const choice = output.choices[0]
    if (choice.message.refusal || choice.finish_reason === 'content_filter') throw new ProviderFailure('refusal')
    if (choice.finish_reason !== 'stop' || !choice.message.content?.trim()) throw new ProviderFailure('invalid_output')
    return { content: choice.message.content, provider: this.name, model: this.model, latencyMs: Date.now() - start }
  }
}
