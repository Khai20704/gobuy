import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Server } from 'node:http'
import { randomUUID } from 'node:crypto'
import { candidateItemSchema, isPublicHttpsUrl, DEFAULT_RANKING_WEIGHTS, type CandidateItem, type CommerceDecision, type SearchIntent } from '@gobuy/shared'
import { createApp } from '../src/app.ts'
import { IntentExtractor, extractDevIntent } from '../src/services/ai/intentExtractor.ts'
import { explainRecommendations } from '../src/services/ai/explainRecommendations.ts'
import { SearchAggregator, canonicalProductUrl } from '../src/services/search/SearchAggregator.ts'
import { WebSearchProvider } from '../src/services/search/WebSearchProvider.ts'
import { EbayProvider } from '../src/services/search/EbayProvider.ts'
import { MagicEdenProvider } from '../src/services/search/MagicEdenProvider.ts'
import { MockSearchProvider } from '../src/services/search/MockSearchProvider.ts'
import { fetchJson } from '../src/services/search/http.ts'
import { evaluateSeller } from '../src/services/verification/sellerEvaluator.ts'
import { verifyCandidate } from '../src/services/verification/verifyCandidates.ts'
import { rankCandidates } from '../src/services/ranking/rankCandidates.ts'
import { deriveTwin } from '../src/services/twin/CommerceTwinService.ts'
import { FileTwinStore, MemoryTwinStore } from '../src/services/twin/TwinStore.ts'
import { NaResearchService } from '../src/application/NaResearchService.ts'
import { OpenAIProvider } from '../src/ai/providers/OpenAIProvider.ts'
import { recordSourceEvidence } from '../src/services/verification/evidence.ts'
import { evaluateWebsite } from '../src/services/verification/websiteEvaluator.ts'
import { applyTwinIntent } from '../src/services/ranking/rankCandidates.ts'
import { enrichProductPage, extractProductPage, fetchPublicHtml, isPublicIPv4 } from '../src/services/search/productPage.ts'
import { trustedSellerPremium } from '../src/services/verification/priceResearch.ts'

const intent: SearchIntent = { product: 'RX-78', keywords: ['Bandai', 'RX-78'], brand: 'Bandai', model: 'RX-78', maxPrice: 100, currency: 'USD', preferences: { reputableSeller: true } }
const item = (overrides: Partial<CandidateItem> = {}): CandidateItem => recordSourceEvidence({
  id: 'product:one', title: 'Bandai RX-78 authentic', price: 80, currency: 'USD', productUrl: 'https://store.example.com/item/1',
  source: 'test-source', domain: 'store.example.com', mode: 'real', kind: 'product', brand: 'Bandai', model: 'RX-78', condition: 'New', fetchedAt: new Date().toISOString(), signals: {}, ...overrides,
})
const goodSeller = { name: 'Shop', rating: 99, ratingScale: 'percent' as const, reviewCount: 1000, historyYears: 5 }

test('intent is dynamic and validated; dev parser handles budgets and makes its limitations explicit', async () => {
  const dev = extractDevIntent('Na, find me an authentic Gundam RX-78 under 1,000,000 VND. I prefer reputable sellers.')
  assert.equal(dev.maxPrice, 1_000_000); assert.equal(dev.currency, 'VND'); assert.equal(dev.preferences.authentic, true)
  assert.deepEqual(dev.keywords, ['Gundam', 'RX-78'])
  assert.equal(extractDevIntent('Find headphones under 1.5 million VND').maxPrice, 1_500_000)
  assert.equal(extractDevIntent('Find a laptop under 1.000.000 VND').maxPrice, 1_000_000)
  assert.equal(extractDevIntent('Find a camera under 99.50 USD').maxPrice, 99.5)
  assert.equal(extractDevIntent('Find a camera under 100 usd').currency, 'USD')
  assert.throws(() => extractDevIntent('Find camera over 200 USD under 100 USD'), /valid price range/)
  assert.equal(extractDevIntent('Find NFT collection: okay_bears under 2 SOL').collectionSymbol, 'okay_bears')
  const required = extractDevIntent('Find a shirt size XL under 100 USD. Ship to VN')
  assert.equal(required.size, 'XL'); assert.equal(required.preferences.shippingCountry, 'VN'); assert.deepEqual(required.keywords, ['shirt'])
  assert.equal(extractDevIntent('Find a case compatible with Camera A under 100 USD').compatibleWith, 'Camera A')
  assert.throws(() => extractDevIntent('Find headphones. Ship to an unspecified country'), /country code/)
  const wire = { action: 'FIND', quantity: null, category: 'electronics', product: 'camera', brand: null, model: null, keywords: ['camera'], maxPrice: 50, minPrice: null,
    currency: 'USD', collectionSymbol: null, size: null, compatibleWith: null,
    preferences: { authentic: null, reputableSeller: true, condition: null, shippingCountry: null, priceSensitivity: null, minSellerTrust: null } }
  const extractor = new IntentExtractor({ async generate(_instructions, input) { assert.deepEqual(input, { message: 'Any other product' }); return wire } })
  const extracted = await extractor.extract('Any other product')
  assert.equal(extracted.mode, 'llm'); assert.equal(extracted.intent.product, 'camera'); assert.equal(extracted.intent.brand, undefined)
  await assert.rejects(new IntentExtractor({ async generate() { return { ...wire, maxPrice: -1 } } }).extract('x'), /valid search intent/)
  await assert.rejects(new IntentExtractor({ async generate() { return { ...wire, products: ['invented'] } } }).extract('x'))
})

test('LLM transport uses strict output schema, no tools, no storage, and a server-side key', async () => {
  const llm = new OpenAIProvider('secret', 'test-model', async (url, init) => {
    assert.equal(String(url), 'https://api.openai.com/v1/responses')
    const body = JSON.parse(String(init?.body))
    assert.equal(body.store, false); assert.equal(body.tools, undefined); assert.equal(body.text.format.strict, true)
    assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer secret')
    return Response.json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: '{"ok":true}' }] }] })
  })
  const result = await llm.generate({ systemPrompt: 'instructions', messages: [{ role: 'user', content: '{}' }],
    responseFormat: 'json', jsonSchema: { name: 'test', schema: { type: 'object' } } }, AbortSignal.timeout(1000))
  assert.deepEqual(JSON.parse(result.content), { ok: true })
})

test('aggregator isolates failures/timeouts, aborts, rejects malformed URLs and deduplicates by listing URL', async () => {
  let aborted = false
  const provider = (name: string) => ({ name, mode: 'real' as const })
  const result = await new SearchAggregator([
    { ...provider('test-source'), async search() { return [item(), item({ id: 'duplicate', productUrl: 'https://store.example.com/item/1?utm_source=x#fragment' }), item({ id: 'bad', productUrl: 'javascript:alert(1)' })] } },
    { ...provider('broken'), async search() { throw new Error('secret credential') } },
    { ...provider('slow'), async search(_intent, signal) { signal.addEventListener('abort', () => { aborted = true }); return new Promise<never>(() => {}) } },
  ], 25).search(intent)
  assert.equal(result.items.length, 1); assert.equal(result.reports.filter(r => r.status === 'failed').length, 2)
  assert.equal(aborted, true); assert.equal(JSON.stringify(result).includes('secret'), false)
  assert.equal(canonicalProductUrl('https://www.example.com/a/?utm_source=x&variant=red#x'), 'https://example.com/a?variant=red')
  assert.notEqual(canonicalProductUrl('https://example.com/a?variant=red'), canonicalProductUrl('https://example.com/a?variant=blue'))
  for (const url of ['http://example.com', 'https://127.0.0.1/a', 'https://2130706433/', 'https://user:pass@example.com/', 'https://host.internal/', 'file:///etc/passwd', 'https://[::1]/', 'https://example.com:444/']) assert.equal(isPublicHttpsUrl(url), false, url)
  assert.equal(candidateItemSchema.safeParse(item({ seller: { rating: 4.8 } })).success, false)
})

test('Brave keeps source URLs but never invents prices or sellers from a snippet', async () => {
  const provider = new WebSearchProvider('key', async (url, init) => {
    assert.equal(new URL(String(url)).hostname, 'api.search.brave.com'); assert.match(String(url), /q=/)
    assert.equal(init?.redirect, 'error')
    return Response.json({ web: { results: [{ title: '<b>Bandai RX-78</b>', url: 'https://shop.example.com/rx', description: 'Authentic, $80 and five-star seller!', thumbnail: { src: 'javascript:bad' } }, { title: 'Unsafe', url: 'http://127.0.0.1/' }] } })
  }, async () => undefined)
  const results = await provider.search(intent, AbortSignal.timeout(1000))
  assert.equal(results.length, 1); assert.equal(results[0].title, 'Bandai RX-78')
  assert.equal(results[0].price, undefined); assert.equal(results[0].seller, undefined); assert.equal(results[0].imageUrl, undefined)
  assert.equal(results[0].kind, 'web-page'); assert.equal(results[0].mode, 'real')
})

test('eBay distinguishes feedback percentage, net score, and absent review count', async () => {
  const provider = new EbayProvider('token', 'EBAY_US', async (_url, init) => {
    assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer token')
    return Response.json({ itemSummaries: [{ itemId: 'v1|12|0', title: 'Bandai RX-78', itemWebUrl: 'https://www.ebay.com/itm/12',
      price: { value: '89.95', currency: 'USD' }, seller: { username: 'shop', feedbackPercentage: '99.5', feedbackScore: 800 }, condition: 'New' }, { title: 'Broken' }] })
  })
  const [candidate] = await provider.search(intent, AbortSignal.timeout(1000))
  assert.equal(candidate.price, 89.95); assert.equal(candidate.seller?.ratingScale, 'percent')
  assert.equal(candidate.seller?.reviewCount, undefined); assert.equal(candidate.seller?.verified, undefined)
  assert.equal(candidate.seller?.feedbackScore, 800)
  assert.ok(evaluateSeller(candidate).missingSignals.includes('Seller review count'))
})

test('Magic Eden uses a fixed read-only mainnet endpoint and does not invent verification', async () => {
  const mint = '11111111111111111111111111111111'
  const provider = new MagicEdenProvider(true, undefined, async url => {
    assert.match(String(url), /^https:\/\/api-mainnet.magiceden.dev\/v2\/collections\/okay_bears\/listings/)
    return Response.json([{ tokenMint: mint, price: 1.2, seller: mint, token: { name: 'Bear #1', image: 'https://images.example.com/1.png' } }])
  })
  assert.match(provider.unavailable(intent)!, /exact/)
  const [candidate] = await provider.search({ ...intent, collectionSymbol: 'okay_bears' }, AbortSignal.timeout(1000))
  assert.equal(candidate.currency, 'SOL'); assert.equal(candidate.kind, 'nft'); assert.equal(candidate.signals.authenticity, undefined)
  assert.equal(candidate.productUrl, `https://magiceden.io/item-details/${mint}`)
  const nftIntent = extractDevIntent('Find NFT listings from collection: okay_bears under 2 SOL')
  assert.equal(rankCandidates([candidate], nftIntent, deriveTwin()).length, 0)
  assert.equal(verifyCandidate(candidate, nftIntent).authenticity, 'UNKNOWN')
})

test('provider responses have bounded size and require JSON', async () => {
  await assert.rejects(fetchJson('https://example.com', {}, async () => new Response('<html>', { headers: { 'content-type': 'text/html' } })))
  await assert.rejects(fetchJson('https://example.com', {}, async () => new Response('"' + 'x'.repeat(2_000_001) + '"', { headers: { 'content-type': 'application/json' } })), /too large/)
})

test('authenticity requires evidence, unknown currency is never treated as within budget, conflicts are explicit', () => {
  assert.equal(verifyCandidate(item(), intent).authenticity, 'UNKNOWN')
  assert.equal(verifyCandidate(item({ currency: 'VND' }), intent).budget, 'UNKNOWN')
  assert.equal(verifyCandidate(item({ price: 101 }), intent).budget, 'OUTSIDE')
  assert.equal(verifyCandidate(item({ price: 0 }), { ...intent, maxPrice: 0 }).budget, 'WITHIN')
  assert.ok(verifyCandidate(item({ brand: 'Other brand' }), intent).hardViolations.length)
  const claim = { status: 'VERIFIED' as const, basis: 'listing-claim' as const, note: 'Authentic!', reference: 'https://example.com/evidence' }
  assert.equal(verifyCandidate(item({ signals: { authenticity: claim } }), intent).authenticity, 'UNKNOWN')
  assert.equal(verifyCandidate(item({ signals: { authenticity: { ...claim, basis: 'manufacturer' } } }), intent).authenticity, 'VERIFIED')
  assert.equal(verifyCandidate(item({ mode: 'mock', signals: { authenticity: { ...claim, basis: 'manufacturer' } } }), intent).authenticity, 'UNKNOWN')
  assert.equal(evaluateSeller(item()).score, 0); assert.equal(evaluateSeller(item()).missingSignals.length, 5)
})

test('ranking is deterministic, explainable, honors hard budgets, and can favor trusted sellers', () => {
  const candidates = [item({ id: 'cheap', price: 80 }), item({ id: 'trusted', price: 84, seller: goodSeller }), item({ id: 'over', price: 101, seller: goodSeller }), item({ id: 'wrong', brand: 'Wrong' })]
  const twin = deriveTwin({ sellerReputationImportance: 'high', acceptHigherPriceForTrustedSeller: 0.05 })
  const first = rankCandidates(candidates, intent, twin)
  assert.equal(first[0].item.id, 'trusted'); assert.equal(first.length, 2)
  assert.deepEqual(first, rankCandidates(candidates, intent, twin))
  assert.ok(first[0].preferenceReasons.some(reason => reason.includes('premium')))
  for (const result of first) assert.equal(Math.round(Object.values(result.scoreBreakdown).reduce((a, b) => a + b, 0) * 100) / 100, result.totalScore)
  assert.throws(() => rankCandidates(candidates, intent, twin, { productMatch: 0, budgetMatch: 0, sellerTrust: 0, preferenceMatch: 0, productEvidence: 0, websiteTrust: 0 }))
  assert.equal(rankCandidates([item({ currency: 'SOL' })], intent, twin).length, 0)
})

test('grounded LLM explanations reject unknown IDs and reason indexes without changing scores', async () => {
  const ranked = rankCandidates([item()], intent, deriveTwin())
  const original = structuredClone(ranked)
  assert.equal(await explainRecommendations(ranked, { async generate() { return { choices: [{ candidateId: 'invented', reasonIndexes: [999], opening: 'selected' }] } } }), 'deterministic')
  assert.deepEqual(ranked, original)
  assert.equal(await explainRecommendations(ranked, { async generate() { return { choices: [{ candidateId: ranked[0].item.id, reasonIndexes: [0, 2], opening: 'selected' }] } } }), 'llm-grounded')
  assert.equal(ranked[0].totalScore, original[0].totalScore)
  assert.ok(ranked[0].explanation.includes(ranked[0].reasons[2]))
})

test('hard requirements cannot be offset by seller trust or a low price', () => {
  const twin = deriveTwin(), strong = { seller: goodSeller, price: 1 }
  const ranked = (candidate: CandidateItem, request: SearchIntent = intent) => rankCandidates([candidate], request, twin)
  for (const change of [{ stockStatus: 'OUT_OF_STOCK' as const }, { model: 'RX-79' }, { brand: 'Other' }, { price: undefined }]) {
    assert.equal(ranked(item({ ...strong, ...change })).length, 0)
  }
  assert.equal(ranked(item({ ...strong, condition: 'Used' }), { ...intent, preferences: { condition: 'New' } }).length, 0)
  assert.equal(ranked(item(strong), { ...intent, size: 'XL' }).length, 0)
  assert.equal(ranked(item({ ...strong, compatibleWith: ['Model B'] }), { ...intent, compatibleWith: 'Model A' }).length, 0)
  assert.equal(ranked(item(strong), { ...intent, preferences: { shippingCountry: 'VN' } }).length, 0)
  assert.equal(ranked(item({ ...strong, signals: { shippingCountries: ['VN'], excludedShippingCountries: ['VN'] } }), { ...intent, preferences: { shippingCountry: 'VN' } }).length, 0)
  assert.equal(ranked(item({ ...strong, title: 'Bandai RX-780', model: undefined })).length, 0)
  assert.equal(ranked(item(), { ...intent, preferences: { minSellerTrust: 50 } }).length, 0)
  const noEvidence = item(); noEvidence.evidence = []
  assert.equal(ranked(noEvidence).length, 0)
})

test('authenticity requirements and Twin constraints apply before scoring; current instructions take precedence', () => {
  assert.equal(rankCandidates([item()], intent, deriveTwin({ authentic: true })).length, 0)
  assert.equal(rankCandidates([item()], { ...intent, preferences: { authentic: false } }, deriveTwin({ authentic: true })).length, 1)
  const genuine = item({ signals: { authenticity: { status: 'HIGH CONFIDENCE', basis: 'manufacturer', reference: 'https://brand.example.com/retailers', note: 'Manufacturer attestation for this offer.' } } })
  assert.equal(rankCandidates([genuine], { ...intent, preferences: { authentic: true } }, deriveTwin()).length, 1)
  const standing = deriveTwin({ maxPrice: 75, currency: 'USD', condition: 'New', shippingCountry: 'VN', minSellerTrust: 70 })
  assert.equal(applyTwinIntent({ ...intent, maxPrice: undefined }, standing).maxPrice, undefined)
  assert.equal(applyTwinIntent(intent, standing).maxPrice, 100)
  assert.equal(applyTwinIntent({ ...intent, maxPrice: undefined, currency: 'VND' }, standing).maxPrice, undefined)
  assert.equal(applyTwinIntent({ ...intent, preferences: { authentic: undefined } }, deriveTwin({ authentic: true })).preferences.authentic, true)
  assert.equal(rankCandidates([item()], { ...intent, maxPrice: undefined }, standing).length, 0)
})

test('price checks include known fees, preserve unknown totals, and respect shipping destination', () => {
  const over = item({ price: 90, costs: { shipping: 8, requiredFees: 5, currency: 'USD', shippingCountry: 'US' } })
  assert.equal(verifyCandidate(over, intent).effectivePrice, 103)
  assert.equal(rankCandidates([over], intent, deriveTwin()).length, 0)
  const partial = verifyCandidate(item({ costs: { currency: 'USD', shipping: 5 } }), intent)
  assert.equal(partial.effectivePrice, undefined); assert.equal(partial.knownPayablePrice, 85)
  assert.equal(verifyCandidate(item({ costs: { currency: 'USD', shipping: 0, requiredFees: 0 } }), intent).effectivePrice, 80)
  const otherDestination = verifyCandidate(over, { ...intent, preferences: { shippingCountry: 'VN' } })
  assert.equal(otherDestination.effectivePrice, undefined); assert.equal(otherDestination.knownPayablePrice, 90)
  const cheaper = item({ price: 80, costs: { currency: 'USD', shipping: 5, requiredFees: 5, shippingCountry: 'US' } })
  const trusted = item({ price: 84, seller: goodSeller, costs: { currency: 'USD', shipping: 10, requiredFees: 5, shippingCountry: 'US' } })
  const checked = (candidate: CandidateItem) => ({ item: candidate, verification: verifyCandidate(candidate, intent) })
  assert.ok(Math.abs(trustedSellerPremium(checked(trusted), [checked(cheaper)])! - 0.1) < 1e-8)
  assert.equal(trustedSellerPremium(checked(trusted), [checked(item({ price: 80 }))]), undefined)
})

test('equivalent price research penalizes anomalies and never compares different variants or currencies', () => {
  const candidates = [item({ id: 'suspicious', price: 10 }), item({ id: 'normal-a', price: 80 }), item({ id: 'normal-b', price: 82 })]
  const ranked = rankCandidates(candidates, intent, deriveTwin())
  const suspicious = ranked.find(candidate => candidate.item.id === 'suspicious')!
  assert.equal(suspicious.verification.priceAssessment, 'VERY LOW'); assert.equal(suspicious.scoreBreakdown.budgetMatch, 0)
  assert.notEqual(ranked[0].item.id, 'suspicious')
  assert.equal(suspicious.verification.authenticity, 'UNKNOWN')
  const different = rankCandidates([candidates[0], item({ id: 'different', size: 'XL' }), item({ id: 'foreign', currency: 'VND' })], intent, deriveTwin())
  assert.equal(different[0].verification.priceAssessment, 'UNKNOWN')
})

test('review volume matters and website trust needs independent evidence beyond HTTPS or seller claims', () => {
  const sparse = item({ productRating: 5, productReviewCount: 3 }), established = item({ productRating: 4.8, productReviewCount: 5000 })
  assert.ok(verifyCandidate(established, intent).productEvidenceScore > verifyCandidate(sparse, intent).productEvidenceScore)
  assert.equal(evaluateWebsite(item()).status, 'UNKNOWN')
  const site = item({ signals: { website: { businessIdentity: 'Shop Inc', contact: 'Contact page', returnPolicy: true, independentReputation: 'positive', authorizedRetailer: true } } })
  assert.equal(evaluateWebsite(site).status, 'UNKNOWN')
  for (const field of ['businessIdentity', 'contact', 'returnPolicy', 'independentReputation', 'authorizedRetailer']) site.evidence!.push({ field: `website.${field}`, statement: 'Retrieved evidence', kind: 'VERIFIED_FACT', reference: 'https://brand.example.com/stores', retrievedAt: site.fetchedAt })
  assert.equal(evaluateWebsite(site).status, 'HIGH CONFIDENCE')
  assert.deepEqual(DEFAULT_RANKING_WEIGHTS, { productMatch: 25, budgetMatch: 20, sellerTrust: 20, productEvidence: 15, websiteTrust: 10, preferenceMatch: 10 })
})

test('eBay detail research records provenance, fees stay unknown, estimates never become purchase counts', async () => {
  const listing = { itemId: 'v1|42|0', title: 'Bandai RX-78', itemWebUrl: 'https://www.ebay.com/itm/42', price: { value: '90', currency: 'USD' }, condition: 'New' }
  const provider = new EbayProvider('key', 'EBAY_US', async url => String(url).includes('item_summary')
    ? Response.json({ itemSummaries: [listing] })
    : Response.json({ ...listing, brand: 'Bandai', localizedAspects: [{ name: 'Model', value: 'RX-78' }],
      estimatedAvailabilities: [{ estimatedAvailabilityStatus: 'IN_STOCK', estimatedSoldQuantity: 100 }],
      primaryProductReviewRating: { averageRating: '4.8', reviewCount: 200 }, returnTerms: { returnsAccepted: true, returnInstructions: 'Return within 30 days' },
      shippingOptions: [{ shippingCost: { value: '12', currency: 'USD' }, shipToLocationUsedForEstimate: { country: 'VN' } }],
      shipToLocations: { regionIncluded: [{ regionType: 'COUNTRY', regionId: 'VN' }] } }))
  const [candidate] = await provider.search({ ...intent, preferences: { shippingCountry: 'VN' } }, AbortSignal.timeout(1000))
  assert.equal(candidate.stockStatus, 'IN_STOCK'); assert.equal(candidate.productRating, 4.8); assert.equal(candidate.productReviewCount, 200)
  assert.equal(candidate.purchaseCount, undefined); assert.equal(candidate.costs?.requiredFees, undefined)
  assert.equal(candidate.costs?.shipping, 12); assert.equal(candidate.model, 'RX-78')
  assert.ok(candidate.evidence?.some(e => e.field === 'price' && e.reference === listing.itemWebUrl && e.kind === 'SOURCE_CLAIM'))
  assert.equal(rankCandidates([candidate], { ...intent, preferences: { shippingCountry: 'VN' } }, deriveTwin()).length, 0)
})

test('direct retail product pages supply attributed offers, never authenticate themselves', async () => {
  const data = { '@context': 'https://schema.org', '@type': 'Product', name: 'Bandai RX-78', brand: { name: 'Bandai' }, model: 'RX-78',
    offers: { '@type': 'Offer', price: '80', priceCurrency: 'USD', availability: 'https://schema.org/InStock', itemCondition: 'https://schema.org/NewCondition', seller: { name: 'Retail shop' } },
    aggregateRating: { ratingValue: '4.8', reviewCount: 120 } }
  const html = `<script type="application/ld+json">${JSON.stringify({ '@graph': [data, { '@type': 'Organization', name: 'Retail shop', email: 'support@example.com' }] })}</script>`
  const provider = new WebSearchProvider('key', async () => Response.json({ web: { results: [{ title: 'Search title', url: 'https://store.example.com/item/1' }] } }), async () => html)
  const [candidate] = await provider.search(intent, AbortSignal.timeout(1000))
  assert.equal(candidate.kind, 'product'); assert.equal(candidate.price, 80); assert.equal(candidate.model, 'RX-78')
  assert.equal(candidate.stockStatus, 'IN_STOCK'); assert.equal(candidate.productReviewCount, 120)
  assert.equal(candidate.purchaseCount, undefined); assert.equal(candidate.seller?.verified, undefined)
  assert.equal(candidate.evidence?.every(e => e.kind === 'SOURCE_CLAIM'), true)
  assert.equal(verifyCandidate(candidate, intent).authenticity, 'UNKNOWN'); assert.equal(evaluateWebsite(candidate).status, 'UNKNOWN')
  assert.equal(rankCandidates([candidate], intent, deriveTwin()).length, 1)
  const parse = (value: unknown) => extractProductPage(item({ kind: 'web-page' }), `<script type='application/ld+json'>${JSON.stringify(value)}</script>`)
  assert.equal(parse({ ...data, offers: { '@type': 'AggregateOffer', lowPrice: 1, priceCurrency: 'USD' } }), undefined)
  assert.equal(parse([data, data]), undefined)
  assert.equal(parse({ ...data, offers: { ...data.offers, url: 'https://another.example.com/offer' } }), undefined)
  assert.equal(parse({ ...data, offers: { ...data.offers, url: '/item/1?variant=other' } }), undefined)
  assert.equal(parse({ ...data, offers: { ...data.offers, priceValidUntil: '2020-01-01' } }), undefined)
  assert.equal(parse({ ...data, offers: { ...data.offers, businessFunction: 'LeaseOut' } }), undefined)
  assert.equal(parse({ ...data, aggregateRating: { ratingValue: 8, bestRating: 10, reviewCount: 100 } })?.productRating, undefined)
})

test('page retrieval rejects private addresses and preserves leads when enrichment fails', async () => {
  for (const address of ['127.0.0.1', '10.0.0.2', '192.168.1.1', '172.31.1.1', '169.254.169.254', '100.100.100.200', '0.0.0.0', '224.1.1.1', '::1', '999.1.1.1', '192.0.2.1', '198.18.0.1']) assert.equal(isPublicIPv4(address), false, address)
  assert.equal(isPublicIPv4('8.8.8.8'), true)
  await assert.rejects(fetchPublicHtml('https://127.0.0.1/', AbortSignal.timeout(1000)), /Unsafe/)
  const lead = item({ kind: 'web-page', price: undefined })
  assert.deepEqual(await enrichProductPage(lead, AbortSignal.timeout(1000), async () => { throw new Error('blocked') }), lead)
  assert.deepEqual(await enrichProductPage(lead, AbortSignal.timeout(1000), async () => '<html>Only a promotional claim</html>'), lead)
})

test('live research compares internally, exposes one selection, rejects hidden decisions and fails without multiple offers', async () => {
  const offers = [80, 84, 90].map((price, index) => item({ id: `live:${index}`, productUrl: `https://store.example.com/item/${index}`, price, seller: index === 1 ? goodSeller : undefined }))
  const makeLive = (items: CandidateItem[]) => new NaResearchService(new IntentExtractor(), new SearchAggregator([{ name: 'test-source', mode: 'real', async search() { return items } }]), new MemoryTwinStore(), { mode: 'real' })
  const service = makeLive(offers)
  const result = await service.search('browser', 'Find Bandai RX-78 under 100 USD')
  assert.equal(result.recommendations.length, 1); assert.equal(result.researchedCount, 3); assert.equal(result.eligibleCount, 3)
  assert.equal(result.recommendations[0].item.id, 'live:1')
  await assert.rejects(service.decide('browser', { searchId: result.searchId, candidateId: 'live:0', outcome: 'approve' }), /not recommended/)
  assert.equal((await makeLive(offers.slice(0, 1)).search('browser', 'Find Bandai RX-78 under 100 USD')).recommendations.length, 0)
  assert.equal((await makeLive(offers).search('browser', 'Find authentic Bandai RX-78 under 100 USD')).recommendations.length, 0)
})

const decision = (overrides: Partial<CommerceDecision> = {}): CommerceDecision => ({ id: randomUUID(), searchId: randomUUID(), outcome: 'approve', item: item(), trustScore: 80, at: new Date().toISOString(), ...overrides })
test('Commerce Twin learns from repeated real decisions and explicit settings override transparent rules', () => {
  const history = Array.from({ length: 3 }, () => decision({ outcome: 'reject', reason: 'Too expensive' }))
    .concat(Array.from({ length: 3 }, () => decision({ trustedPricePremium: 0.05 })))
  const twin = deriveTwin({ priceSensitivity: 'low' }, history)
  assert.equal(twin.learned.priceSensitivity, 'high'); assert.equal(twin.effective.priceSensitivity, 'low')
  assert.equal(twin.effective.sellerReputationImportance, 'high'); assert.equal(twin.learned.acceptHigherPriceForTrustedSeller, 0.05)
  assert.equal(twin.learningReasons.length, 3); assert.equal(twin.autonomyBoundaries.purchasesEnabled, false)
  assert.deepEqual(deriveTwin({}, history.map(d => ({ ...d, item: item({ mode: 'mock' }) }))).learned, {})
})

test('file store survives restart and serializes concurrent decisions for one browser', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gobuy-twin-test-'))
  try {
    const store = new FileTwinStore(dir), session = 'a'.repeat(64)
    await Promise.all(Array.from({ length: 5 }, () => store.update(session, value => ({ ...value, history: [...value.history, decision()] }))))
    assert.equal((await new FileTwinStore(dir).read(session)).history.length, 5)
    assert.equal((await store.read('b'.repeat(64))).history.length, 0)
    await assert.rejects(store.read('../unsafe'))
  } finally { await rm(dir, { recursive: true, force: true }) }
})

let server: Server, base: string
const makeService = (store = new MemoryTwinStore(), ttlMs?: number) => new NaResearchService(new IntentExtractor(), new SearchAggregator([new MockSearchProvider()]), store, { mode: 'mock', ttlMs })
before(async () => {
  server = createApp(undefined, makeService()).listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No listener')
  base = 'http://127.0.0.1:' + address.port
})
after(() => new Promise<void>(resolve => server.close(() => resolve())))
const api = (path: string, body?: unknown, cookie?: string, method = 'POST') => fetch(base + '/api/research' + path, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) })

test('research API validates input, isolates browser sessions, saves idempotent decisions and creates a blocked authority handoff', async () => {
  const response = await api('/search', { text: 'Find headphones under 100 USD' })
  assert.equal(response.status, 200)
  const cookie = response.headers.get('set-cookie')!.split(';')[0]
  assert.match(response.headers.get('set-cookie')!, /HttpOnly/)
  const research = await response.json()
  assert.equal(research.mode, 'mock'); assert.equal(research.recommendations.length, 1)
  const input = { searchId: research.searchId, candidateId: research.recommendations[0].item.id, outcome: 'approve' }
  assert.equal((await api('/decisions', input)).status, 400)
  assert.equal((await api('/decisions', { ...input, price: 1 }, cookie)).status, 400)
  const first = await (await api('/decisions', input, cookie)).json()
  const duplicate = await (await api('/decisions', input, cookie)).json()
  assert.equal(first.decision.id, duplicate.decision.id); assert.equal(duplicate.twin.history.length, 1)
  assert.equal(first.handoff.status, 'REVIEW_REQUIRED'); assert.deepEqual(first.handoff.item, research.recommendations[0].item)
  assert.equal(first.approved, undefined); assert.equal(first.signature, undefined)
  assert.equal((await api('/decisions', { ...input, outcome: 'reject' }, cookie)).status, 400)
  const updated = await (await api('/twin', { sellerReputationImportance: 'high' }, cookie, 'PATCH')).json()
  assert.equal(updated.effective.sellerReputationImportance, 'high')
  assert.equal((await (await api('/twin', undefined, cookie, 'GET')).json()).history.length, 1)
  assert.equal((await (await api('/twin', undefined, undefined, 'GET')).json()).history.length, 0)
  assert.equal((await api('/search', { text: ' ' })).status, 400)
  assert.equal((await api('/search', { text: 'x', authorized: true })).status, 400)
  const denied = await fetch(base + '/api/research/twin', { headers: { Origin: 'https://attacker.example' } })
  assert.equal(denied.status, 403)
  const proxyRequest = await fetch(base + '/api/research/twin', { headers: { Origin: 'http://127.0.0.1:5173', 'Sec-Fetch-Site': 'same-origin' } })
  assert.equal(proxyRequest.status, 200)
  const malformedOrigin = await fetch(base + '/api/research/twin', { headers: { Origin: 'null' } })
  assert.equal(malformedOrigin.status, 403)
})

test('expired or forged decisions are rejected and outages do not switch live search to mock', async () => {
  const service = makeService(new MemoryTwinStore(), -1)
  const response = await service.search('session', 'Find a camera under 100 USD')
  await assert.rejects(service.decide('session', { searchId: response.searchId, candidateId: response.recommendations[0].item.id, outcome: 'approve' }), /expired/)
  const live = new NaResearchService(new IntentExtractor(), new SearchAggregator([{ name: 'live', mode: 'real', async search() { throw new Error('key') } }]), new MemoryTwinStore(), { mode: 'real' })
  const outage = await live.search('live-session', 'Find camera under 100 USD')
  assert.equal(outage.mode, 'real'); assert.deepEqual(outage.recommendations, []); assert.equal(outage.providers[0].status, 'failed')
})
