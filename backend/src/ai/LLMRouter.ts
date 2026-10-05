import { z } from 'zod'
import type { LLMProvider, LLMRequest, LLMResponse } from './LLMProvider.js'
import { compactContext, prepareRequest } from './context.js'
import { classifyProviderError, LLMContextError, LLMRefusalError, LLMUnavailableError, ProviderFailure } from './errors/classifyProviderError.js'
import { CircuitBreaker } from '../services/CircuitBreaker.js'

export interface RouterEvent {
  operation: string
  provider: string
  model: string
  outcome: 'success' | 'failed' | 'skipped' | 'configured' | 'not_configured' | 'available' | 'unavailable'
  latencyMs: number
  failoverCount: number
  category?: string
}
export interface RouterOptions {
  requestTimeoutMs?: number
  totalTimeoutMs?: number
  failureThreshold?: number
  cooldownMs?: number
  now?: () => number
  logger?: (event: RouterEvent) => void
}
const requestSchema = z.object({
  messages: z.array(z.object({ role: z.enum(['user', 'assistant', 'system']), content: z.string().min(1), discardable: z.boolean().optional() })).min(1),
  systemPrompt: z.string().optional(), temperature: z.number().min(0).max(2).optional(), maxTokens: z.number().int().positive().optional(),
  totalTimeoutMs: z.number().int().positive().optional(), responseFormat: z.enum(['text', 'json']).optional(),
  jsonSchema: z.object({ name: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/), schema: z.record(z.string(), z.unknown()) }).optional(),
})

export function parseModelJSON(content: string): unknown {
  const trimmed = content.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i, '$1')
  try { return JSON.parse(trimmed) as unknown } catch { throw new ProviderFailure('invalid_output') }
}

async function bounded<T>(timeoutMs: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([Promise.resolve().then(() => run(controller.signal)), new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new ProviderFailure('timeout')) }, Math.max(1, timeoutMs))
    })])
  } finally { clearTimeout(timer); controller.abort() }
}

export class LLMRouter {
  private readonly circuits: Map<LLMProvider, CircuitBreaker>
  private readonly now: () => number
  constructor(private readonly providers: LLMProvider[], private readonly options: RouterOptions = {}) {
    if (new Set(providers.map(provider => provider.name)).size !== providers.length) throw new Error('Duplicate LLM provider')
    this.now = options.now ?? Date.now
    this.circuits = new Map(providers.map(provider => [provider, new CircuitBreaker(options.failureThreshold, options.cooldownMs, this.now)]))
  }
  isConfigured() { return this.providers.some(provider => provider.isConfigured()) }
  status() { return this.providers.map(provider => ({ provider: provider.name, model: provider.model, configured: provider.isConfigured(), ...this.circuits.get(provider)!.snapshot() })) }
  private log(event: RouterEvent) {
    try { this.options.logger?.(event) } catch { /* Logging must not interrupt research. */ }
  }
  async reportAvailability() {
    // Cloud configuration is not advertised as verified connectivity. No paid startup requests.
    await Promise.all(this.providers.map(async provider => {
      let outcome: RouterEvent['outcome'] = provider.isConfigured() ? 'configured' : 'not_configured'
      if (provider.isConfigured() && provider.checkAvailability) {
        const available = await bounded(1200, signal => provider.checkAvailability!(signal)).catch(() => false)
        outcome = available ? 'available' : 'unavailable'
      }
      this.log({ operation: 'startup', provider: provider.name, model: provider.model, outcome, latencyMs: 0, failoverCount: 0 })
    }))
  }

  async generate(input: LLMRequest): Promise<LLMResponse> {
    requestSchema.parse(input)
    if (input.jsonSchema && input.responseFormat !== 'json') throw new Error('A JSON schema requires JSON output')
    let request = prepareRequest(input)
    const deadline = this.now() + Math.min(input.totalTimeoutMs ?? Infinity, this.options.totalTimeoutMs ?? 120000)
    const operation = input.operation && /^[a-zA-Z0-9_-]{1,80}$/.test(input.operation) ? input.operation : 'generate'
    let failoverCount = 0, contextRetried = false, contextFloor: number | undefined
    for (const [providerIndex, provider] of this.providers.entries()) {
      if (!provider.isConfigured()) continue
      // Never spray a known oversized prompt at equal/smaller or unknown windows.
      if (contextFloor !== undefined && (!provider.contextWindowTokens || provider.contextWindowTokens <= contextFloor)) continue
      const circuit = this.circuits.get(provider)!, ticket = circuit.acquire()
      if (ticket === undefined) {
        this.log({ operation, provider: provider.name, model: provider.model, outcome: 'skipped', category: 'circuit_open', latencyMs: 0, failoverCount })
        continue
      }
      // Reserve time for configured fallbacks instead of letting the first provider
      // consume the whole operation deadline (including its repair attempt).
      const remainingProviders = this.providers.slice(providerIndex).filter(item => item.isConfigured()).length
      const providerDeadline = this.now() + Math.max(1, Math.floor((deadline - this.now()) / remainingProviders))
      let repaired = false, providerRequest = request
      while (true) {
        if (this.now() >= deadline) { circuit.release(ticket); throw new LLMUnavailableError() }
        const started = this.now()
        try {
          const result = await bounded(Math.min(this.options.requestTimeoutMs ?? 30000, providerDeadline - started), async signal => {
            if (provider.checkAvailability && !await bounded(Math.min(1200, deadline - this.now()), probeSignal => provider.checkAvailability!(AbortSignal.any([signal, probeSignal])))) throw new ProviderFailure('connection')
            const { validate, ...data } = providerRequest
            void validate
            return provider.generate(structuredClone(data), signal)
          })
          if (typeof result.content !== 'string' || !result.content.trim()) throw new ProviderFailure('invalid_output')
          let content = result.content
          if (request.responseFormat === 'json') {
            const value = parseModelJSON(content)
            try { request.validate?.(value) }
            catch (error) { if (error instanceof z.ZodError) throw new ProviderFailure('invalid_output'); throw error }
            content = JSON.stringify(value)
          }
          circuit.success(ticket)
          const latencyMs = this.now() - started
          this.log({ operation, provider: provider.name, model: provider.model, outcome: 'success', latencyMs, failoverCount })
          return { content, provider: provider.name, model: provider.model, latencyMs, failoverCount }
        } catch (error) {
          const category = classifyProviderError(error)
          this.log({ operation, provider: provider.name, model: provider.model, outcome: 'failed', category, latencyMs: this.now() - started, failoverCount })
          if (category === 'application' || category === 'invalid_request') { circuit.release(ticket); throw error }
          if (category === 'refusal') { circuit.release(ticket); throw new LLMRefusalError() }
          if (category === 'context_length') {
            if (!contextRetried) {
              contextRetried = true
              const compacted = compactContext(request)
              if (compacted.messages.length < request.messages.length) { request = compacted; providerRequest = compacted; continue }
            }
            circuit.release(ticket)
            contextFloor = Math.max(contextFloor ?? 0, provider.contextWindowTokens ?? Number.MAX_SAFE_INTEGER)
            failoverCount++; break
          }
          if (category === 'invalid_output' && !repaired) {
            repaired = true
            providerRequest = { ...request, systemPrompt: request.systemPrompt + '\nThe previous output was invalid. Return a complete value matching the supplied JSON schema exactly, without markdown. Do not change the input constraints.' }
            continue
          }
          circuit.failure(ticket)
          failoverCount++; break
        }
      }
    }
    if (contextFloor !== undefined) throw new LLMContextError()
    throw new LLMUnavailableError()
  }
}
