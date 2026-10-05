import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NFTIntentParser, DiscoveryEngine } from '../src/services/acquisition/discovery.js'
import { resolveConversationInput, type NaConversationState } from '../src/services/acquisition/NaConversationContext.js'
import { AcquisitionService } from '../src/services/acquisition/AcquisitionService.js'
import { FileAssetStore } from '../src/persistence/AssetStore.js'
import { providerHttpFailure } from '../src/ai/errors/classifyProviderError.js'

const screenshot = 'Tìm cho tui NFT dưới 1 SOL đang có tỉ lệ giá tăng cao nhất trong tương lai'
const parser = new NFTIntentParser()
test('screenshot collection is preserved without turning Vietnamese shopping instructions into a symbol', async () => {
  const result = await parser.parse('Mua cho tui nft dưới 1 sol đáng mua nhất trong collection Retardio_Cousins')
  assert.equal(result.collectionQuery, 'Retardio_Cousins')
  assert.equal(result.collectionSymbol, 'Retardio_Cousins')
  assert.deepEqual(result.terms, ['retardio', 'cousins'])
  assert.equal(result.maximumLamports, '999999999')
})
for (const text of [screenshot, 'tim nft dau tu duoi 1 SOL', 'Mua NFT sinh lời dưới 1 SOL',
  'NFT nào tiềm năng x10 dưới 1 SOL?', 'Find NFT with the highest upside under 1 SOL',
  'Which NFT will go up in value below 1 SOL?', 'Should I buy NFTs under 1 SOL for profit?']) {
  test(`research fallback: ${text}`, async () => {
    const intent = await parser.parse(text)
    assert.equal(intent.requestKind, 'investment_research')
    assert.equal(intent.action, text.startsWith('Mua ') ? 'BUY' : 'SEARCH')
    assert.deepEqual(intent.priorities, [])
    assert.equal(intent.collectionSymbol, undefined)
    assert.equal(intent.maximumLamports, '999999999')
  })
}
for (const text of ['Chỉ xem NFT dưới 1 SOL, chưa mua', 'Đừng mua, tìm tranh NFT dưới 1 SOL',
  "Don't buy, just search NFT under 1 SOL", 'Có nên mua NFT dưới 1 SOL?', 'NFT nào đáng mua dưới 1 SOL?']) {
  test(`no purchase authority: ${text}`, async () => assert.equal((await parser.parse(text)).action, 'SEARCH'))
}
test('subjects, named projects, inclusive budgets and exact strict budgets survive fallback', async () => {
  const shoes = await parser.parse('tui cần mua bức tranh NFT về giày không quá 0,5 SOL')
  assert.ok(shoes.terms.includes('shoes'))
  assert.ok(shoes.terms.includes('giay'))
  assert.equal(shoes.action, 'BUY')
  assert.equal(shoes.maximumLamports, '500000000')
  assert.equal(shoes.collectionSymbol, undefined)
  assert.equal((await parser.parse('Find NFT less than 0.5 SOL')).maximumLamports, '499999999')
  assert.equal((await parser.parse('Find NFT at most 0.5 SOL')).maximumLamports, '500000000')
  assert.deepEqual((await parser.parse('Tìm NFT rẻ nhất dưới 1 SOL')).priorities, ['price'])
  assert.deepEqual((await parser.parse('Tìm NFT hiếm nhất dưới 1 SOL')).priorities, ['rarity'])
  const kanpai = await parser.parse('Mua Kanpai Pandas dưới 1 SOL')
  assert.equal(kanpai.collectionQuery, 'Kanpai Pandas')
  assert.equal(kanpai.collectionSymbol, undefined)
  assert.equal(kanpai.action, 'BUY')
  assert.equal(kanpai.objective, 'BEST_OVERALL')
})
test('worth-buying recommendation wording does not cancel an explicit buy command', async () => {
  const intent = await parser.parse('mua nft dưới 1 SOL đáng mua nhất')
  assert.equal(intent.action, 'BUY')
  assert.equal(intent.objective, 'BEST_OVERALL')
  assert.equal(intent.broadSearch, true)
  assert.equal((await parser.parse('NFT nào đáng mua dưới 1 SOL?')).action, 'SEARCH')
  assert.equal((await parser.parse('có NFT nào đang mua nhiều dưới 1 SOL không?')).action, 'SEARCH')
})
test('structured interpretation separates subjects, cannot grant authority, and reports outage accurately', async () => {
  const llm = new NFTIntentParser({ isConfigured: () => true, generate: async request => {
    assert.equal(request.temperature, undefined)
    assert.ok(request.jsonSchema)
    return { content: JSON.stringify({ semanticQuery: 'shoes sneakers', terms: ['shoes', 'sneakers'],
      requestKind: 'discovery', collectionSymbol: 'invented_project', priorities: [] }), provider: 'fixture', model: 'fixture', latencyMs: 0 }
  } })
  const intent = await llm.parse('Tìm NFT về giày dưới 0.5 SOL')
  assert.equal(intent.maximumLamports, '499999999')
  assert.equal(intent.action, 'SEARCH')
  assert.equal(intent.collectionSymbol, undefined)
  assert.equal(intent.parserStatus, 'ready')
  assert.deepEqual(intent.terms, ['shoes', 'sneakers'])
  assert.equal((await llm.parse(screenshot)).requestKind, 'investment_research')
  const offline = new NFTIntentParser({ isConfigured: () => true, generate: async () => { throw new Error('secret') } })
  assert.equal((await offline.parse(screenshot)).parserStatus, 'unavailable')
  assert.equal((await parser.parse(screenshot)).parserStatus, 'not_configured')
  assert.equal(providerHttpFailure(429, { error: { code: 'credit_balance_exhausted' } }).category, 'quota')
})
test('conversation switches subject, preserves a clarified budget, and never repeats a buy', async () => {
  const state: NaConversationState = { currentPrompt: 'Mua ocean NFT under 1 SOL',
    currentIntent: await parser.parse('Mua ocean NFT under 1 SOL'), previousMints: [], messages: [] }
  const changed = await resolveConversationInput('Tìm NFT giày dưới 0.5 SOL', state, parser)
  assert.ok('intent' in changed)
  assert.ok(changed.intent.terms.includes('shoes'))
  assert.ok(!changed.intent.terms.includes('ocean'))
  assert.equal(changed.intent.maximumLamports, '499999999')
  const budget = await resolveConversationInput('không quá 0.5 SOL', state, parser)
  assert.ok('intent' in budget)
  assert.ok(budget.intent.terms.includes('ocean'))
  assert.equal(budget.intent.action, 'SEARCH')
  const next = await resolveConversationInput('Tìm cái khác', state, parser)
  assert.ok('intent' in next)
  assert.equal(next.intent.action, 'SEARCH')
  await assert.rejects(resolveConversationInput('max 0.5 SOL and 2 SOL', state, parser))
})
test('future-return request searches market data but remains search-only, then accepts a measurable criterion', async () => {
  const root = await mkdtemp(join(tmpdir(), 'na-intent-'))
  let searches = 0
  const provider = { name: 'fixture', search: async () => { searches++; return [] }, refresh: async () => undefined }
  const service = new AcquisitionService(new DiscoveryEngine([provider]), parser, undefined, undefined,
    new FileAssetStore(join(root, 'discoveries')), undefined, undefined, undefined,
    new FileAssetStore(join(root, 'conversations')))
  const reply = await service.discover('alice', screenshot, undefined, 'conversation')
  assert.equal(searches, 1)
  assert.equal(reply.intent.action, 'SEARCH')
  assert.equal(reply.status, 'NO_MATCH')
  assert.deepEqual(reply.candidates, [])
  assert.match(reply.message, /Không tìm thấy listing phù hợp/)
  assert.match(reply.message, /không có nghĩa NFT đó không tồn tại/)
  await assert.rejects(service.prepare('alice', reply.id, 'invented', 'wallet'))
  const next = await service.discover('alice', 'Ưu tiên giá thấp', undefined, 'conversation')
  assert.equal(searches, 2)
  assert.equal(next.intent.requestKind, 'discovery')
  assert.equal(next.intent.maximumLamports, '999999999')
  assert.deepEqual(next.intent.priorities, ['price'])
  assert.equal(next.intent.broadSearch, true)
  assert.equal(next.intent.action, 'SEARCH')
})
test('plural "collections" wording resolves a named collection instead of asking for a budget', async () => {
  const plural = await parser.parse('Mua nft rẻ nhất của collections DeGods')
  assert.equal(plural.collectionQuery, 'DeGods')
  assert.equal(plural.priceDiscoveryOnly, true)
  assert.equal(plural.maximumLamports, '9007199254740991')
  assert.equal(plural.action, 'BUY')
  assert.deepEqual(plural.terms, ['degods'])
  assert.ok(plural.priorities.includes('price'))
  const singular = await parser.parse('Mua NFT rẻ nhất của collection y00ts')
  assert.equal(singular.collectionQuery, 'y00ts')
  assert.equal(singular.priceDiscoveryOnly, true)
  const address = '4mKSoDDqApmF1DqXvVTSL6tu2zixrSSNjqMxUnwvVzy2'
  assert.equal((await parser.parse(`Mua NFT rẻ nhất của collections ${address}`)).collectionQuery, address)
  assert.equal((await parser.parse('Mua NFT rẻ nhất DeGods dưới 1 SOL')).collectionQuery, 'DeGods')
  assert.equal((await parser.parse('Mua NFT rẻ nhất DeGods dưới 1 SOL')).maximumLamports, '999999999')
})

test('a request with neither a resolvable collection nor a SOL budget still asks for the budget', async () => {
  await assert.rejects(parser.parse('Mua NFT rẻ nhất'), /Nêu một ngân sách/)
  await assert.rejects(parser.parse('Mua NFT rẻ nhất dưới 1 SOL và 2 SOL'), /Nêu một ngân sách/)
  await assert.rejects(parser.parse('Mua NFT rẻ nhất của collections'), /Nêu một ngân sách/)
})
