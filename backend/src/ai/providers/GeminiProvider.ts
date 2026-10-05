import { z } from 'zod'
import type { LLMProvider, LLMRequest } from '../LLMProvider.js'
import { requestMessages } from '../context.js'
import { ProviderFailure } from '../errors/classifyProviderError.js'
import { parseResponse, providerJson, type Fetcher } from './http.js'

const responseSchema = z.object({ candidates: z.array(z.object({ finishReason: z.string().optional(),
  content: z.object({ parts: z.array(z.object({ text: z.string().optional(), thought: z.boolean().optional() })) }).optional(),
})).optional(), promptFeedback: z.object({ blockReason: z.string().optional() }).optional() })
export class GeminiProvider implements LLMProvider {
  readonly name = 'gemini'
  readonly contextWindowTokens?: number
  constructor(private readonly key?: string, readonly model = 'gemini-2.5-flash', private readonly fetcher: Fetcher = fetch, contextWindowTokens?: number) {
    this.contextWindowTokens = contextWindowTokens ?? (model === 'gemini-2.5-flash' ? 1048576 : undefined)
  }
  isConfigured() { return !!this.key?.trim() && !!this.model }
  async generate(request: LLMRequest, signal: AbortSignal) {
    const start = Date.now(), messages = requestMessages(request)
    const output = parseResponse(responseSchema, await providerJson(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.model)}:generateContent`, {
      method: 'POST', signal, headers: { 'x-goog-api-key': this.key!, 'Content-Type': 'application/json' },
      body: JSON.stringify({ systemInstruction: { parts: [{ text: messages.filter(message => message.role === 'system').map(message => message.content).join('\n') }] },
        contents: messages.filter(message => message.role !== 'system').map(message => ({ role: message.role === 'assistant' ? 'model' : 'user', parts: [{ text: message.content }] })),
        generationConfig: { maxOutputTokens: request.maxTokens ?? 1600,
          ...(this.model === 'gemini-2.5-flash' ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
          ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
          ...(request.responseFormat === 'json' ? { responseMimeType: 'application/json', responseJsonSchema: request.jsonSchema?.schema } : {}),
        },
      }),
    }, this.fetcher))
    const candidate = output.candidates?.[0]
    if (output.promptFeedback?.blockReason || candidate?.finishReason && ['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII'].includes(candidate.finishReason)) throw new ProviderFailure('refusal')
    if (candidate?.finishReason !== 'STOP') throw new ProviderFailure('invalid_output')
    const content = candidate.content?.parts.filter(part => !part.thought).map(part => part.text ?? '').join('') ?? ''
    if (!content.trim()) throw new ProviderFailure('invalid_output')
    return { content, provider: this.name, model: this.model, latencyMs: Date.now() - start }
  }
}
