import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SerpApiProvider } from '../src/services/search/SerpApiProvider.ts'
import { SearchAggregator } from '../src/services/search/SearchAggregator.ts'
import { productSearchQuery } from '../src/services/search/searchQuery.ts'
import { NaResearchService } from '../src/application/NaResearchService.ts'
import { IntentExtractor } from '../src/services/ai/intentExtractor.ts'
import { MemoryTwinStore } from '../src/services/twin/TwinStore.ts'

const intent = { product: 'Gundam RX-78', keywords: ['Gundam', 'RX-78'], currency: 'VND', maxPrice: 1000000, preferences: {} }

test('SerpApi authenticates, localizes and retains safe leads without trusting snippet prices', async () => {
  const provider = new SerpApiProvider('secret', async (input, init) => {
    const url = new URL(String(input))
    assert.equal(url.origin, 'https://serpapi.com')
    assert.equal(url.searchParams.get('api_key'), 'secret')
    assert.equal(url.searchParams.get('engine'), 'google')
    assert.equal(url.searchParams.get('q'), 'Gundam RX-78')
    assert.equal(url.searchParams.get('gl'), 'vn')
    assert.equal(init?.redirect, 'error')
    return Response.json({ search_metadata: { status: 'Success' }, organic_results: [
      { title: '<b>RX-78</b>', link: 'https://shop.example.com/item', snippet: 'Only 100 VND, trusted seller', thumbnail: 'javascript:bad' },
      { title: 'Unsafe', link: 'https://127.0.0.1/item' },
    ] })
  }, async () => undefined)
  const result = await new SearchAggregator([provider]).search(intent, { allowLLM: false })
  assert.equal(result.reports[0].status, 'ok')
  assert.equal(result.items.length, 1)
  assert.equal(result.items[0].title, 'RX-78')
  assert.equal(result.items[0].price, undefined)
  assert.equal(result.items[0].seller, undefined)
  assert.equal(result.items[0].imageUrl, undefined)
  assert.doesNotMatch(JSON.stringify(result), /secret/)
})

test('product query preserves model numbers without repeated terms or spending filters', () => {
  assert.equal(productSearchQuery({ ...intent, product: 'airpod 3', keywords: ['airpod', '3'], model: 'airpod 3' }), 'airpod 3')
  assert.equal(productSearchQuery({ ...intent, product: 'Jordan 1', keywords: ['Jordan', '1'], model: 'Jordan 1', size: '42.5' }), 'Jordan 1 42.5')
})

test('unverified discoveries are visible but cannot be approved as recommendations', async () => {
  const provider = new SerpApiProvider('secret', async () => Response.json({ search_metadata: { status: 'Success' },
    organic_results: [{ title: 'Gundam RX-78', link: 'https://shop.example.com/item' }] }), async () => undefined)
  const service = new NaResearchService(new IntentExtractor(), new SearchAggregator([provider]), new MemoryTwinStore(), { mode: 'real' })
  const result = await service.search('test-session', 'Find Gundam RX-78 under 100 USD')
  assert.equal(result.status, 'NO_MATCH')
  assert.equal(result.recommendations.length, 0)
  assert.equal(result.discoveries?.length, 1)
  assert.ok(result.discoveries![0].reasons.some(reason => reason.includes('price')))
  await assert.rejects(service.decide('test-session', { searchId: result.searchId,
    candidateId: result.discoveries![0].item.id, outcome: 'approve' }))
})

test('SerpApi distinguishes empty results, provider failures and missing configuration', async () => {
  assert.match(new SerpApiProvider().unavailable()!, /SERPAPI_KEY/)
  for (const status of ['Success', 'Error', 'Processing']) {
    const provider = new SerpApiProvider('secret', async () => Response.json({ search_metadata: { status }, error: 'secret' }))
    const result = await new SearchAggregator([provider]).search(intent)
    assert.equal(result.reports[0].status, status === 'Success' ? 'ok' : 'failed')
    assert.equal(result.items.length, 0)
    assert.doesNotMatch(JSON.stringify(result), /secret/)
  }
})
