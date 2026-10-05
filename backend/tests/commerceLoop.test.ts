import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import type { CandidateItem, ExchangeRate, PurchaseAuthorization, SearchIntent } from '@gobuy/shared'
import { IntentExtractor, extractDevIntent } from '../src/services/ai/intentExtractor.ts'
import { OpenAIWebSearchProvider } from '../src/services/search/OpenAIWebSearchProvider.ts'
import { SearchAggregator } from '../src/services/search/SearchAggregator.ts'
import { recordSourceEvidence } from '../src/services/verification/evidence.ts'
import { verifyCandidate } from '../src/services/verification/verifyCandidates.ts'
import { rankCandidates } from '../src/services/ranking/rankCandidates.ts'
import { deriveTwin } from '../src/services/twin/CommerceTwinService.ts'
import { MemoryTwinStore } from '../src/services/twin/TwinStore.ts'
import { NaResearchService } from '../src/application/NaResearchService.ts'
import { SolExchangeRates, convertMoney, sumMoney } from '../src/services/currency/SolExchangeRates.ts'
import { PurchaseService, intentHash, maximumSolLamports, toLamports, type AuthorizedPaymentLayer, type CheckoutQuote } from '../src/services/payment/PurchaseService.ts'

const request: SearchIntent = { action: 'BUY', product: 'Jordan 1 Chicago', model: 'Jordan 1', size: '42.5', quantity: 1,
  keywords: ['Jordan', '1', 'Chicago'], maxPrice: 1, currency: 'SOL', preferences: { authentic: true } }
const offer = (overrides: Partial<CandidateItem> = {}): CandidateItem => recordSourceEvidence({
  id: 'shop:1', title: 'Jordan 1 Chicago', model: 'Jordan 1', size: '42.5', brand: 'Jordan', condition: 'New',
  price: 0.8, currency: 'SOL', costs: { currency: 'SOL', shipping: 0.05, requiredFees: 0.02 }, stockStatus: 'IN_STOCK',
  productUrl: 'https://shop.example.com/jordan-1', domain: 'shop.example.com', source: 'test-shop', kind: 'product', mode: 'real',
  fetchedAt: new Date().toISOString(), seller: { name: 'Shop', rating: 99, ratingScale: 'percent', reviewCount: 5000, historyYears: 5 },
  signals: { authenticity: { status: 'HIGH CONFIDENCE', basis: 'manufacturer', note: 'Fixture manufacturer attestation', reference: 'https://brand.example.com/retailers' } },
  ...overrides,
})
const rate = (value = 100): ExchangeRate => ({ base: 'SOL', quoteCurrency: 'USD', rate: value,
  observedAt: new Date().toISOString(), fetchedAt: new Date().toISOString(), sourceUrl: 'https://api.coingecko.com/api/v3/simple/price' })
const authorization = (intent = request): PurchaseAuthorization => ({ id: randomUUID(), action: 'BUY', maximum: intent.maxPrice!, currency: intent.currency!,
  quantity: intent.quantity ?? 1, intentHash: intentHash(intent), createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString() })
const selected = (item = offer(), intent = request) => rankCandidates([item], intent, deriveTwin())[0]

test('Jordan model numbers, BUY instructions, decimal size and maximum survive natural-language parsing', async () => {
  const find = extractDevIntent('find me jordan 1 under 100 usd')
  assert.deepEqual(find.keywords, ['jordan', '1']); assert.equal(find.model, 'jordan 1'); assert.equal(find.action, 'FIND')
  assert.equal(rankCandidates([offer({ title: 'Jordan 4 Chicago', model: 'Jordan 4', currency: 'USD' })], find, deriveTwin()).length, 0)
  const buy = extractDevIntent('Na, buy me Jordan 1 Chicago size 42.5. Authentic only. Maximum 1 SOL.')
  assert.equal(buy.action, 'BUY'); assert.equal(buy.size, '42.5'); assert.equal(buy.maxPrice, 1); assert.equal(buy.preferences.authentic, true)
  assert.equal(extractDevIntent('Do not buy Jordan 1 under 100 USD').action, 'FIND')
  assert.equal(extractDevIntent('Find headphones at Best Buy under 100 USD').action, 'FIND')
  assert.equal(extractDevIntent('Buy 2 pairs of Jordan 1 under 2 SOL').quantity, 2)
  assert.equal(extractDevIntent('Buy legit Jordan 1 under 1 SOL').preferences.authentic, true)
  const updated = await new IntentExtractor().extract('Okay, maximum 2 SOL.', buy)
  assert.equal(updated.intent.product, buy.product); assert.equal(updated.intent.size, '42.5'); assert.equal(updated.intent.maxPrice, 2)
  await assert.rejects(new IntentExtractor().extract('Maximum 2 SOL'), /which product/)
})

test('unconfigured search is SETUP_REQUIRED, not a failed product match; outages are separate', async () => {
  const setup = new NaResearchService(new IntentExtractor(), new SearchAggregator([new OpenAIWebSearchProvider()]), new MemoryTwinStore(), { mode: 'real' })
  const result = await setup.search('browser', 'find me jordan 1 under 100 usd')
  assert.equal(result.status, 'SETUP_REQUIRED'); assert.equal(result.researchedCount, 0); assert.equal(result.purchase.status, 'NOT_REQUESTED')
  assert.match(result.summary, /has not searched/); assert.match(result.nextStep, /OPENAI_API_KEY/)
  assert.equal(result.warnings.some(warning => /too few|shipping|No LLM/i.test(warning)), false)
  const outage = new NaResearchService(new IntentExtractor(), new SearchAggregator([{ name: 'offline', mode: 'real', async search() { throw new Error('secret') } }]), new MemoryTwinStore(), { mode: 'real' })
  assert.equal((await outage.search('browser', 'Find Jordan 1 under 100 USD')).status, 'SEARCH_UNAVAILABLE')
})

test('OpenAI research requires a live tool call and accepts URLs only from tool provenance', async () => {
  const fetched: string[] = []
  const provider = new OpenAIWebSearchProvider('key', 'search-model', 5000, async (_url, init) => {
    const body = JSON.parse(String(init?.body))
    assert.equal(body.tools[0].type, 'web_search'); assert.equal(body.tools[0].external_web_access, true)
    assert.equal(body.tool_choice, 'required'); assert.equal(body.store, false)
    assert.deepEqual(body.include, ['web_search_call.action.sources'])
    return Response.json({ status: 'completed', output: [
      { type: 'message', content: [{ type: 'output_text', text: 'Buy a $1 fake product at https://invented.example.com' }] },
      { type: 'web_search_call', status: 'completed', action: { sources: [
        { url: 'https://shop.example.com/jordan-1', title: 'Jordan 1' }, { url: 'https://other.example.com/jordan-1' }, { url: 'http://127.0.0.1/' },
      ] } },
    ] })
  }, async url => {
    fetched.push(url)
    return `<script type="application/ld+json">${JSON.stringify({ '@type': 'Product', name: 'Jordan 1 Chicago', model: 'Jordan 1',
      offers: { '@type': 'Offer', price: '80', priceCurrency: 'USD' } })}</script>`
  })
  const items = await provider.search(request, AbortSignal.timeout(1000))
  assert.equal(items.length, 2); assert.equal(items[0].price, 80); assert.equal(items[0].purchaseCount, undefined)
  assert.equal(fetched.some(url => url.includes('invented') || url.includes('127.0.0.1')), false)
  const noTool = new OpenAIWebSearchProvider('key', 'model', 1000, async () => Response.json({ status: 'completed', output: [{ type: 'message' }] }))
  await assert.rejects(noTool.search(request, AbortSignal.timeout(1000)), /did not run/)
  const unauthorized = new OpenAIWebSearchProvider('private-key', 'model', 1000, async () => new Response('secret response', { status: 401 }))
  const failed = await new SearchAggregator([unauthorized]).search(request)
  assert.match(failed.reports[0].message!, /credentials/); assert.equal(JSON.stringify(failed).includes('private-key'), false)
})

test('fresh SOL rates are required; effective costs include fees and rounding never grants extra spending', async () => {
  const fx = new SolExchangeRates(undefined, async url => {
    assert.equal(new URL(String(url)).hostname, 'api.coingecko.com')
    assert.equal(new URL(String(url)).searchParams.get('include_last_updated_at'), 'true')
    return Response.json({ solana: { usd: 100, last_updated_at: Math.floor(Date.now() / 1000) } })
  })
  const rates = await fx.getRates(['USD'])
  const item = offer({ price: 80, currency: 'USD', costs: { currency: 'USD', shipping: 5, requiredFees: 2 } })
  assert.equal(verifyCandidate(item, request, rates).effectivePrice, 0.87)
  assert.equal(rankCandidates([item], request, deriveTwin(), undefined, rates).length, 1)
  assert.equal(rankCandidates([item], request, deriveTwin()).length, 0)
  assert.equal(convertMoney(7, 'USD', 'SOL', [rate(100)]), 0.07)
  assert.equal(sumMoney([0.8, 0.05, 0.02]), 0.87)
  assert.equal(maximumSolLamports(1, 'USD', [rate(3)]), 333333333n)
  assert.equal(toLamports(0.0000000009, 'down'), 0n); assert.equal(toLamports(0.0000000009), 1n)
  const stale = new SolExchangeRates(undefined, async () => Response.json({ solana: { usd: 100, last_updated_at: Math.floor(Date.now() / 1000) - 300 } }))
  await assert.rejects(stale.getRates(['USD']), /stale/)
  assert.equal(convertMoney(1, 'USD', 'SOL', [{ ...rate(), observedAt: '2020-01-01T00:00:00.000Z' }]), undefined)
})

test('BUY cannot use a Twin budget or unknown fees, stock or quantity delivery costs', () => {
  assert.equal(rankCandidates([offer()], { ...request, maxPrice: undefined }, deriveTwin({ maxPrice: 10, currency: 'SOL' })).length, 0)
  assert.equal(rankCandidates([offer({ costs: undefined })], request, deriveTwin()).length, 0)
  assert.equal(rankCandidates([offer({ stockStatus: undefined })], request, deriveTwin()).length, 0)
  assert.equal(rankCandidates([offer()], { ...request, quantity: 2, maxPrice: 10 }, deriveTwin()).length, 0)
})

test('credible budget suggestion is not authorization; explicit follow-up creates a new boundary and new research', async () => {
  let searches = 0
  const items = [offer({ id: 'cheap', price: 0.5, signals: {}, productUrl: 'https://shop.example.com/cheap' }),
    offer({ id: 'credible', price: 1.73, productUrl: 'https://shop.example.com/credible' })]
  const service = new NaResearchService(new IntentExtractor(), new SearchAggregator([{ name: 'test-shop', mode: 'real', async search() { searches++; return items } }]), new MemoryTwinStore(), { mode: 'real' })
  const first = await service.search('browser', 'Buy legit Jordan 1 Chicago size 42.5. Maximum 1 SOL.')
  assert.equal(first.status, 'BUDGET_TOO_LOW'); assert.equal(first.budgetSuggestion?.minimum, 1.8)
  assert.equal(first.authorization?.maximum, 1); assert.equal(first.recommendations.length, 0); assert.equal(first.purchase.status, 'BLOCKED')
  const updated = await service.search('browser', 'Okay, maximum 2 SOL.', first.searchId)
  assert.equal(searches, 2); assert.equal(updated.authorization?.maximum, 2); assert.notEqual(updated.authorization?.id, first.authorization?.id)
  assert.equal(updated.recommendations[0]?.item.id, 'credible'); assert.equal(updated.purchase.status, 'BLOCKED')
  assert.match(updated.purchase.message, /not connected/)
  await assert.rejects(service.search('other-browser', 'Maximum 3 SOL', first.searchId), /another browser/)
})

function gateway(overrides: Partial<AuthorizedPaymentLayer> = {}) {
  let submissions = 0, lastQuote: CheckoutQuote | undefined
  const layer: AuthorizedPaymentLayer = {
    supportsIdempotency: true,
    async quote(_session, item, quantity) {
      lastQuote = { orderId: 'order-1', productId: item.id, productUrl: item.productUrl, merchant: item.seller!.name!, recipient: '11111111111111111111111111111111',
        quantity, currency: 'SOL', itemPriceLamports: '800000000', shippingLamports: '50000000', feesLamports: '20000000',
        checkedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString(), merchantAndDestinationVerified: true }
      return lastQuote
    },
    async authorize(_session, _intent, digest) { return { allowed: true, digest } },
    async submit(_intent, key) { assert.ok(key); submissions++; return { transactionReference: 'confirmed-transaction-reference' } },
    async confirm(transactionReference) { return { status: 'CONFIRMED', transactionReference, merchant: lastQuote!.merchant, orderId: 'order-1', totalLamports: '870000000' } },
    ...overrides,
  }
  return { layer, submissions: () => submissions }
}

test('payment double-check binds product, seller, order, destination, budget and secure authorization', async () => {
  const item = offer(), ranked = selected(item), auth = authorization()
  const ok = gateway(), service = new PurchaseService(ok.layer)
  const results = await Promise.all([service.purchase('browser', auth, ranked, request, async () => item), service.purchase('browser', auth, ranked, request, async () => item)])
  assert.equal(results[0].status, 'CONFIRMED'); assert.equal(results[1].status, 'CONFIRMED'); assert.equal(ok.submissions(), 1)
  assert.equal(results[0].purchaseIntent?.totalLamports, '870000000')
  for (const changed of [offer({ price: 0.81 }), offer({ seller: { name: 'Other' } }), offer({ size: '43' }), offer({ stockStatus: 'OUT_OF_STOCK' }), offer({ fetchedAt: '2020-01-01T00:00:00.000Z' })]) {
    const fake = gateway()
    assert.equal((await new PurchaseService(fake.layer).purchase('browser', authorization(), ranked, request, async () => changed)).status, 'BLOCKED')
    assert.equal(fake.submissions(), 0)
  }
  const denied = gateway({ async authorize(_s, _i, digest) { return { allowed: false, digest } } })
  assert.equal((await new PurchaseService(denied.layer).purchase('browser', authorization(), ranked, request, async () => item)).status, 'BLOCKED')
  assert.equal(denied.submissions(), 0)
  const redirected = gateway({ async quote() { return { ...(await gateway().layer.quote('browser', item, 1)), merchant: 'Other merchant' } } })
  assert.equal((await new PurchaseService(redirected.layer).purchase('browser', authorization(), ranked, request, async () => item)).status, 'BLOCKED')
  assert.equal(redirected.submissions(), 0)
  const swapped = gateway()
  assert.equal((await new PurchaseService(swapped.layer).purchase('browser', auth, ranked, { ...request, size: '43' }, async () => item)).status, 'BLOCKED')
  assert.equal(swapped.submissions(), 0)
})

test('unconfirmed, failed and ambiguous payments never claim purchase and are not automatically retried', async () => {
  for (const status of ['PENDING', 'FAILED'] as const) {
    const mock = gateway({ async confirm(transactionReference) { return { status, transactionReference, merchant: 'Shop', orderId: 'order-1', totalLamports: '870000000' } } })
    const result = await new PurchaseService(mock.layer).purchase('browser', authorization(), selected(), request, async () => offer())
    assert.equal(result.status, status); assert.equal(mock.submissions(), 1); assert.doesNotMatch(result.message, /^PURCHASED/)
  }
  let submits = 0
  const uncertain = gateway({ async submit() { submits++; throw new Error('transport dropped after submit') } })
  const service = new PurchaseService(uncertain.layer), auth = authorization()
  assert.equal((await service.purchase('browser', auth, selected(), request, async () => offer())).status, 'PENDING')
  assert.equal((await service.purchase('browser', auth, selected(), request, async () => offer())).status, 'PENDING')
  assert.equal(submits, 1)
  assert.equal((await new PurchaseService().purchase('browser', authorization(), selected(), request, async () => offer())).status, 'BLOCKED')
})
