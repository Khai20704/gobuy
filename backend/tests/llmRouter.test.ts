import assert from 'node:assert/strict'
import { test } from 'node:test'
import { z } from 'zod'
import { LLMRouter, type RouterEvent } from '../src/ai/LLMRouter.ts'
import type { LLMProvider, LLMRequest } from '../src/ai/LLMProvider.ts'
import { LLMContextError, LLMRefusalError, LLMUnavailableError, ProviderFailure, providerHttpFailure } from '../src/ai/errors/classifyProviderError.ts'
import { OpenAIProvider } from '../src/ai/providers/OpenAIProvider.ts'
import { GeminiProvider } from '../src/ai/providers/GeminiProvider.ts'
import { GroqProvider } from '../src/ai/providers/GroqProvider.ts'
import { OllamaProvider } from '../src/ai/providers/OllamaProvider.ts'
import { RoutedStructuredLLMProvider } from '../src/adapters/llm/RoutedStructuredLLMProvider.ts'
import { IntentExtractor } from '../src/services/ai/intentExtractor.ts'
import { explicitSpendingConstraints } from '../src/services/ai/spendingConstraints.ts'
import { NaResearchService } from '../src/application/NaResearchService.ts'
import { SearchAggregator } from '../src/services/search/SearchAggregator.ts'
import { WebSearchProvider } from '../src/services/search/WebSearchProvider.ts'
import { OpenAIWebSearchProvider } from '../src/services/search/OpenAIWebSearchProvider.ts'
import { MemoryTwinStore } from '../src/services/twin/TwinStore.ts'
import { PurchaseService, type AuthorizedPaymentLayer } from '../src/services/payment/PurchaseService.ts'
import { recordSourceEvidence } from '../src/services/verification/evidence.ts'
import { createApp } from '../src/app.ts'
import { InputError } from '../src/schemas/search.ts'

const schema = z.object({ ok: z.boolean() }).strict()
const request: LLMRequest = { operation: 'intent_extraction', messages: [{ role: 'user', content: 'Find a camera under 1 SOL' }],
  responseFormat: 'json', jsonSchema: { name: 'test', schema: z.toJSONSchema(schema) }, validate: value => schema.parse(value) }
function provider(name: string, action: (request: LLMRequest, signal: AbortSignal) => Promise<string> = async () => '{"ok":true}', window = 128000): LLMProvider & { calls: number } {
  return { name, model: `${name}-test`, contextWindowTokens: window, calls: 0, isConfigured: () => true,
    async generate(input, signal) { this.calls++; return { content: await action(input, signal), provider: name, model: this.model, latencyMs: 1 } } }
}
const fail = (category: ConstructorParameters<typeof ProviderFailure>[0]) => async () => { throw new ProviderFailure(category) }
const wire = (maxPrice = 1) => ({ action: 'BUY', quantity: 1, category: null, product: 'Jordan 1 Chicago', brand: null, model: 'Jordan 1',
  size: '42.5', compatibleWith: null, keywords: ['Jordan', '1', 'Chicago'], maxPrice, minPrice: null, currency: 'SOL', collectionSymbol: null,
  preferences: { authentic: true, reputableSeller: null, condition: null, shippingCountry: null, priceSensitivity: null, minSellerTrust: null } })

test('OpenAI success returns normalized response without calling the next provider', async () => {
  const first = provider('openai'), second = provider('gemini'), events: RouterEvent[] = []
  const result = await new LLMRouter([first, second], { logger: event => events.push(event) }).generate(request)
  assert.equal(result.provider, 'openai'); assert.equal(result.failoverCount, 0); assert.equal(second.calls, 0)
  assert.deepEqual(JSON.parse(result.content), { ok: true }); assert.equal(events[0].outcome, 'success')
})

test('a stalled first provider leaves time for a working fallback within the operation deadline', async () => {
  let aborted = false
  const stalled = provider('stalled', async (_request, signal) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => { aborted = true; reject(new ProviderFailure('timeout')) }, { once: true })
  }))
  const fallback = provider('fallback')
  const result = await new LLMRouter([stalled, fallback], { requestTimeoutMs: 1000 }).generate({ ...request, totalTimeoutMs: 400 })
  assert.equal(result.provider, 'fallback')
  assert.equal(fallback.calls, 1)
  assert.equal(aborted, true)
})

for (const code of ['rate_limit_exceeded', 'insufficient_quota']) test(`HTTP 429 ${code} automatically switches from OpenAI to Gemini`, async () => {
  const openai = new OpenAIProvider('server-openai-secret', 'model', async () => Response.json({ error: { code, message: 'server-openai-secret' } }, { status: 429 }))
  const gemini = new GeminiProvider('server-gemini-secret', 'gemini-test', async (url, init) => {
    assert.equal(new URL(String(url)).search, '')
    assert.equal((init?.headers as Record<string, string>)['x-goog-api-key'], 'server-gemini-secret')
    const body = JSON.parse(String(init?.body))
    assert.match(body.systemInstruction.parts[0].text, /You are Na/)
    assert.equal(body.generationConfig.responseMimeType, 'application/json')
    assert.equal(body.contents[0].role, 'user')
    return Response.json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '{"ok":true}' }] } }] })
  })
  const events: RouterEvent[] = []
  const result = await new LLMRouter([openai, gemini], { logger: event => events.push(event) }).generate(request)
  assert.equal(result.provider, 'gemini'); assert.equal(result.failoverCount, 1)
  assert.equal(events[0].category, code === 'insufficient_quota' ? 'quota' : 'rate_limit')
  assert.doesNotMatch(JSON.stringify(events), /secret|camera|SOL/)
})

test('Gemini NOT_FOUND after OpenAI rate limiting preserves deterministic shopping search', async () => {
  const gemini = new GeminiProvider('test-key', 'missing-model', async () =>
    Response.json({ error: { code: 404, status: 'NOT_FOUND' } }, { status: 404 }))
  const llm = new RoutedStructuredLLMProvider(new LLMRouter([provider('openai', fail('rate_limit')), gemini]))
  const result = await new IntentExtractor(llm).extract('Find an authentic Gundam RX-78 under 1,000,000 VND from a reputable seller')
  assert.equal(result.mode, 'deterministic')
  assert.equal(result.intent.product, 'Gundam RX-78')
  assert.equal(result.intent.maxPrice, 1000000)
  assert.equal(result.intent.currency, 'VND')
  assert.equal(result.intent.action, 'FIND')
  assert.equal(result.intent.preferences.authentic, true)
  assert.equal(result.intent.preferences.reputableSeller, true)
})

test('OpenAI and Gemini outages use an installed Ollama model as final fallback', async () => {
  const paths: string[] = []
  const ollama = new OllamaProvider('http://localhost:11434', 'qwen2.5:7b', async (url, init) => {
    paths.push(new URL(String(url)).pathname)
    if (String(url).endsWith('/api/tags')) return Response.json({ models: [{ name: 'qwen2.5:7b' }] })
    const body = JSON.parse(String(init?.body))
    assert.equal(body.stream, false); assert.equal(body.options.num_ctx, 8192); assert.deepEqual(body.format, request.jsonSchema!.schema)
    return Response.json({ done: true, done_reason: 'stop', message: { content: '{"ok":true}' } })
  })
  const result = await new LLMRouter([provider('openai', fail('quota')), provider('gemini', fail('unavailable')), ollama]).generate(request)
  assert.equal(result.provider, 'ollama'); assert.equal(result.failoverCount, 2)
  assert.deepEqual(paths, ['/api/tags', '/api/chat'])
})

test('all providers failing produces the normalized retryable error; missing providers are skipped', async () => {
  const missing = provider('missing'); missing.isConfigured = () => false
  const router = new LLMRouter([missing, provider('openai', fail('quota')), provider('gemini', fail('rate_limit')), provider('groq', fail('timeout')), provider('ollama', fail('connection'))])
  await assert.rejects(router.generate(request), error => error instanceof LLMUnavailableError && error.code === 'ALL_LLM_PROVIDERS_UNAVAILABLE' && error.retryable)
  assert.equal(missing.calls, 0)
  await assert.rejects(new LLMRouter([]).generate(request), LLMUnavailableError)
})

test('malformed JSON and schema violations receive one repair; no malformed value reaches business logic', async () => {
  for (const invalid of ['bad json', '{"ok":"not a boolean"}', '{"ok":true,"wallet":"invented"}']) {
    let calls = 0
    const source = provider('openai', async input => {
      if (++calls === 1) return invalid
      assert.match(input.systemPrompt!, /previous output was invalid/)
      assert.deepEqual(input.messages, request.messages)
      return '```json\n{"ok":true}\n```'
    })
    assert.equal((await new LLMRouter([source]).generate(request)).provider, 'openai'); assert.equal(calls, 2)
  }
  const invalid = provider('openai', async () => '{}')
  assert.equal((await new LLMRouter([invalid, provider('gemini')]).generate(request)).provider, 'gemini')
  assert.equal(invalid.calls, 2)
  await assert.rejects(new LLMRouter([invalid]).generate(request), LLMUnavailableError)
})

test('application, authorization, transaction and malformed internal requests never trigger provider failover', async () => {
  for (const error of [new InputError('GoBuy validation failed'), new Error('transaction validation'), new ProviderFailure('invalid_request', 400)]) {
    const fallback = provider('gemini')
    await assert.rejects(new LLMRouter([provider('openai', async () => { throw error }), fallback]).generate(request), caught => caught === error)
    assert.equal(fallback.calls, 0)
  }
  const first = provider('openai')
  await assert.rejects(new LLMRouter([first]).generate({ ...request, messages: [] }), z.ZodError)
  assert.equal(first.calls, 0)
  const second = provider('gemini')
  await assert.rejects(new LLMRouter([first, second]).generate({ ...request, validate() { throw new InputError('not authorized') } }), InputError)
  assert.equal(second.calls, 0)
  await assert.rejects(new LLMRouter([provider('openai', fail('refusal')), second]).generate(request), LLMRefusalError)
  assert.equal(second.calls, 0)
})

test('quota, context, bad credentials and model availability have distinct classifications', () => {
  assert.equal(providerHttpFailure(429, { error: { message: 'Request too large: tokens per minute limit' } }).category, 'rate_limit')
  assert.equal(providerHttpFailure(400, { error: { code: 'context_length_exceeded' } }).category, 'context_length')
  assert.equal(providerHttpFailure(400, { error: { message: 'input token count exceeds limit' } }).category, 'context_length')
  assert.equal(providerHttpFailure(400, { error: { message: 'invalid JSON schema' } }).category, 'invalid_request')
  assert.equal(providerHttpFailure(401, {}).category, 'credentials')
  assert.equal(providerHttpFailure(403, {}).category, 'credentials')
  assert.equal(providerHttpFailure(404, { error: { code: 'model_not_found' } }).category, 'model_unavailable')
  assert.equal(providerHttpFailure(503, {}).category, 'unavailable')
})

test('context compaction preserves user messages, exact financial state and evidence, then tries only a larger model', async () => {
  const critical = { maximum: 1, currency: 'SOL', quantity: 1, product: 'Jordan 1', recipient: 'bound-wallet', evidence: ['verified-offer'], transaction: { total: '1000000000' } }
  const input: LLMRequest = { ...request, protectedContext: critical, messages: [
    { role: 'user', content: 'Original purchase constraints: 1 SOL maximum' },
    { role: 'assistant', content: 'old verbose summary'.repeat(100), discardable: true },
    { role: 'user', content: 'Buy Jordan 1, maximum 1 SOL', discardable: true },
  ] }
  const small = provider('openai', async req => {
    assert.deepEqual(req.protectedContext, critical)
    if (small.calls === 2) { assert.equal(req.messages.length, 2); assert.equal(req.messages[1].content, input.messages[2].content) }
    throw new ProviderFailure('context_length')
  }, 100)
  const equal = provider('groq', undefined, 100), larger = provider('gemini', async req => {
    assert.equal(req.messages.length, 2); assert.deepEqual(req.protectedContext, critical); return '{"ok":true}'
  }, 1000)
  const router = new LLMRouter([small, equal, larger])
  assert.equal((await router.generate(input)).provider, 'gemini')
  assert.equal(small.calls, 2); assert.equal(equal.calls, 0); assert.equal(router.status()[0].state, 'CLOSED')
  assert.equal(input.messages.length, 3); assert.deepEqual(input.protectedContext, critical)
  await assert.rejects(new LLMRouter([provider('small', fail('context_length'), 100), provider('smaller', undefined, 50)]).generate(request), LLMContextError)
})

test('a failed provider cannot mutate normalized state sent to fallback', async () => {
  const input = { ...request, protectedContext: { maximum: 1, currency: 'SOL' } }
  const broken = provider('openai', async req => { req.messages[0].content = 'changed'; req.protectedContext!.maximum = 99; throw new ProviderFailure('unavailable') })
  const next = provider('gemini', async req => { assert.deepEqual(req.messages, request.messages); assert.equal(req.protectedContext?.maximum, 1); return '{"ok":true}' })
  await new LLMRouter([broken, next]).generate(input)
  assert.equal(input.protectedContext.maximum, 1)
})

test('circuit opens at threshold, skips failures and permits one half-open probe after cooldown', async () => {
  let now = 0, recover = false, release: (() => void) | undefined
  const first = provider('openai', async () => {
    if (!recover) throw new ProviderFailure('quota')
    await new Promise<void>(resolve => { release = resolve }); return '{"ok":true}'
  }), fallback = provider('gemini')
  const router = new LLMRouter([first, fallback], { failureThreshold: 2, cooldownMs: 100, now: () => now })
  await router.generate(request); await router.generate(request); await router.generate(request)
  assert.equal(first.calls, 2); assert.equal(router.status()[0].state, 'OPEN')
  now = 101; recover = true
  const probe = router.generate(request)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(router.status()[0].state, 'HALF_OPEN')
  assert.equal((await router.generate(request)).provider, 'gemini')
  release!(); assert.equal((await probe).provider, 'openai'); assert.equal(router.status()[0].state, 'CLOSED')
  recover = false
  await router.generate(request); await router.generate(request)
  now = 202; await router.generate(request)
  assert.equal(router.status()[0].state, 'OPEN')
})

test('timeouts abort even adapters ignoring the signal and continue to fallback', async () => {
  let aborted = false
  const slow = provider('openai', async (_req, signal) => { signal.addEventListener('abort', () => { aborted = true }); return new Promise<never>(() => {}) })
  const result = await new LLMRouter([slow, provider('gemini')], { requestTimeoutMs: 15, totalTimeoutMs: 500 }).generate(request)
  assert.equal(result.provider, 'gemini'); assert.equal(aborted, true)
})

test('unreachable or missing Ollama is probed quickly, never sends generation, and does not stop startup', async () => {
  let generations = 0
  const local = new OllamaProvider('http://localhost:11434', 'local-model', async (url, init) => {
    if (String(url).endsWith('/api/chat')) generations++
    return new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(new TypeError('connection secret'))))
  }, 8192, 10)
  const events: RouterEvent[] = []
  const router = new LLMRouter([local], { logger: event => events.push(event) })
  await router.reportAvailability()
  await assert.rejects(router.generate(request), LLMUnavailableError)
  assert.equal(generations, 0); assert.equal(events[0].outcome, 'unavailable')
  assert.doesNotMatch(JSON.stringify(events), /secret/)
  const missingModel = new OllamaProvider('http://localhost:11434', 'missing', async () => Response.json({ models: [] }))
  assert.equal(await missingModel.checkAvailability(AbortSignal.timeout(1000)), false)
})

test('Groq JSON transport includes shared Na identity, normalized history and schema without tools', async () => {
  const groq = new GroqProvider('private-groq-key', 'llama-3.3-70b-versatile', async (url, init) => {
    assert.equal(String(url), 'https://api.groq.com/openai/v1/chat/completions')
    const body = JSON.parse(String(init?.body))
    assert.equal(body.tools, undefined); assert.equal(body.response_format.type, 'json_object'); assert.equal(body.stream, false)
    assert.match(body.messages[0].content, /You are Na/); assert.match(body.messages[0].content, /JSON/)
    assert.equal(body.messages[1].content, request.messages[0].content)
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: '{"ok":true}' } }] })
  })
  assert.equal((await new LLMRouter([groq]).generate(request)).provider, 'groq')
})

test('provider switch across research turns preserves session state, product, quantity and maximum', async () => {
  const first = provider('openai', async () => { if (first.calls > 1) throw new ProviderFailure('quota'); return JSON.stringify(wire()) })
  const fallback = provider('gemini', async req => {
    const previous = req.protectedContext?.previousIntent as { maxPrice: number; quantity: number; product: string }
    assert.equal(previous.maxPrice, 1); assert.equal(previous.quantity, 1); assert.equal(previous.product, 'Jordan 1 Chicago')
    assert.ok(req.messages.some(message => message.content.includes('Buy Jordan 1 Chicago')))
    return JSON.stringify({ ...wire(1.8), quantity: 9, product: 'Jordan 4 Chicago', model: 'Jordan 4' })
  })
  const llm = new RoutedStructuredLLMProvider(new LLMRouter([first, fallback]))
  const service = new NaResearchService(new IntentExtractor(llm), new SearchAggregator([{ name: 'independent', mode: 'real', async search() { return [] } }]), new MemoryTwinStore(), { mode: 'real', llm })
  const initial = await service.search('browser', 'Buy Jordan 1 Chicago size 42.5. Maximum 1 SOL.')
  const continued = await service.search('browser', 'Same product, only trusted sellers', initial.searchId)
  assert.equal(continued.intent.maxPrice, 1); assert.equal(continued.intent.currency, 'SOL'); assert.equal(continued.intent.quantity, 1)
  assert.equal(continued.intent.product, 'Jordan 1 Chicago'); assert.equal(continued.intent.size, '42.5')
  assert.equal(continued.authorization, undefined)
  await assert.rejects(service.search('other-browser', 'Same product', initial.searchId), /another browser/)
})

test('maximum 1 SOL remains authoritative when fallback proposes 1.8 SOL; backend blocks payment', async () => {
  let submitted = 0
  const layer: AuthorizedPaymentLayer = { supportsIdempotency: true,
    async quote() { throw new Error('must never quote an over-budget offer') },
    async authorize(_session, _intent, digest) { return { allowed: true, digest } },
    async submit() { submitted++; return { transactionReference: 'not-allowed' } },
    async confirm() { throw new Error('must never confirm') },
  }
  const llm = new RoutedStructuredLLMProvider(new LLMRouter([provider('openai', fail('quota')), provider('gemini', async () => JSON.stringify(wire(1.8)))]))
  const sources = new SearchAggregator([{ name: 'live-shop', mode: 'real', async search(intent) {
    assert.equal(intent.maxPrice, 1)
    return [1, 2].map(id => recordSourceEvidence({ id: `offer-${id}`, title: 'Jordan 1 Chicago', model: 'Jordan 1', size: '42.5',
      productUrl: `https://shop.example.com/jordan-${id}`, domain: 'shop.example.com', source: 'live-shop', kind: 'product', mode: 'real',
      price: 1.8, currency: 'SOL', costs: { shipping: 0, requiredFees: 0, currency: 'SOL' }, stockStatus: 'IN_STOCK', fetchedAt: new Date().toISOString(),
      seller: { name: 'Shop', rating: 99, ratingScale: 'percent', reviewCount: 1000 },
      signals: { authenticity: { status: 'HIGH CONFIDENCE', basis: 'manufacturer', reference: 'https://brand.example.com/shop', note: 'Test evidence' } },
    }))
  } }])
  const result = await new NaResearchService(new IntentExtractor(llm), sources, new MemoryTwinStore(), { mode: 'real', llm, payment: new PurchaseService(layer) })
    .search('browser', 'Buy Jordan 1 Chicago size 42.5. Maximum 1 SOL.')
  assert.equal(result.authorization?.maximum, 1); assert.equal(result.purchase.status, 'BLOCKED'); assert.equal(submitted, 0)
  assert.equal(result.recommendations.length, 0)
})

test('explicit spending rules ignore invented model budget/currency/quantity and unsupported spending language', async () => {
  const llm = { async generate() { return { ...wire(100), quantity: 99, currency: 'USD' } } }
  const extractor = new IntentExtractor(llm)
  const { intent } = await extractor.extract('Buy 2 pairs of Jordan 1 Chicago under 1 SOL')
  assert.equal(intent.maxPrice, 1); assert.equal(intent.currency, 'SOL'); assert.equal(intent.quantity, 2)
  const unspecified = await extractor.extract('Buy Jordan 1 Chicago')
  assert.equal(unspecified.intent.maxPrice, undefined); assert.equal(unspecified.intent.currency, undefined)
  assert.equal(explicitSpendingConstraints('mua Jordan 1 tối đa 1 SOL').maximum, 1)
  assert.equal(explicitSpendingConstraints('Buy camera under 100 USD. Maximum 50 USD.').maximum, 50)
  assert.equal(explicitSpendingConstraints('Buy camera under 100 USD or 1 SOL').currency, undefined)
  assert.throws(() => explicitSpendingConstraints('Buy camera under 1.000 SOL'), InputError)
  assert.equal(explicitSpendingConstraints('Buy camera under 1e-3 SOL').maximum, undefined)
  assert.equal(explicitSpendingConstraints('Buy camera under 1/2 SOL').maximum, undefined)
  const initial = await extractor.extract('Can you buy me Jordan 1 Chicago under 1 SOL')
  assert.equal(initial.intent.product, 'Jordan 1 Chicago')
  await assert.rejects(extractor.extract('Maximum 1.000 SOL', initial.intent), InputError)
})

test('Ollama rejects oversized retained data before it could silently truncate financial constraints', async () => {
  let generated = false
  const local = new OllamaProvider('http://localhost:11434', 'local', async () => { generated = true; throw new Error('must not call') }, 2048)
  await assert.rejects(local.generate({ ...request, protectedContext: { maximum: 1, evidence: 'x'.repeat(4000) } }, AbortSignal.timeout(1000)),
    error => error instanceof ProviderFailure && error.category === 'context_length')
  assert.equal(generated, false)
})

test('OpenAI outage leaves independent live Brave search available, including source circuit recovery', async () => {
  let attempts = 0, now = 0
  const openai = new OpenAIWebSearchProvider('test-key', 'search-model', 1000, async () => { attempts++; return new Response('', { status: 429 }) })
  const brave = new WebSearchProvider('brave-key', async () => Response.json({ web: { results: [{ title: 'Jordan 1', url: 'https://shop.example.com/jordan' }] } }), async () => undefined)
  const search = new SearchAggregator([openai, brave], 1000, { failureThreshold: 1, cooldownMs: 100, now: () => now })
  for (let i = 0; i < 2; i++) {
    const result = await search.search({ product: 'Jordan 1', keywords: ['Jordan', '1'], preferences: {} })
    assert.equal(result.items.length, 1); assert.equal(result.items[0].source, 'Brave Web Search')
    assert.equal(result.reports[1].status, 'ok'); assert.equal(result.reports[0].status, 'failed')
  }
  assert.equal(attempts, 1)
  now = 101; await search.search({ keywords: ['Jordan'], preferences: {} }); assert.equal(attempts, 2)
})

test('HTTP API continues deterministic research on total AI outage while application origin denial remains 403', async () => {
  const llm = new RoutedStructuredLLMProvider(new LLMRouter([provider('openai', fail('quota'))]))
  const research = new NaResearchService(new IntentExtractor(llm), new SearchAggregator([]), new MemoryTwinStore(), { mode: 'real', llm })
  const server = createApp(undefined, research).listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  try {
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    const url = `http://127.0.0.1:${address.port}/api/research/search`
    const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'Find camera under 1 SOL' }) })
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.intentMode, 'deterministic'); assert.equal(body.intent.maxPrice, 1); assert.deepEqual(body.recommendations, [])
    assert.match(body.warnings.join(' '), /AI reasoning is temporarily unavailable/)
    assert.doesNotMatch(JSON.stringify(body), /quota|stack/i)
    const denied = await fetch(url, { method: 'POST', headers: { Origin: 'https://attacker.example', 'Content-Type': 'application/json' }, body: '{}' })
    assert.equal(denied.status, 403)
  } finally { await new Promise<void>(resolve => server.close(() => resolve())) }
})
