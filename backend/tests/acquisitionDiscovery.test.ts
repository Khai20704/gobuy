import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Keypair } from '@solana/web3.js'
import { DiscoveryEngine, NFTIntentParser, acquisitionConfig, literalTerms } from '../src/services/acquisition/discovery.js'
import { MockNFTProvider } from '../src/services/acquisition/MockNFTProvider.js'
import { TensorDevnetNFTProvider } from '../src/services/acquisition/TensorDevnetNFTProvider.js'
import { nftProviders } from '../src/services/acquisition/providers.js'
import { NFTAcquisitionRanker, acquisitionRankingConfig } from '../src/services/acquisition/NFTAcquisitionRanker.js'
import { NFTMomentumScorer } from '../src/services/nft-intelligence/NFTMomentumScorer.js'
import { addMarketHistory } from '../src/services/nft-intelligence/NFTFeatureNormalizer.js'
import { NFTRankingService } from '../src/services/nft-intelligence/NFTRankingService.js'
import { NFTSnapshotStore } from '../src/services/nft-intelligence/NFTSnapshotStore.js'
import { FileAssetStore } from '../src/persistence/AssetStore.js'
import { nftMarketFeaturesSchema } from '@gobuy/shared'
test('ranker selects one candidate, lowers confidence when rarity is unavailable, and validates configurable weights', async () => {
  const intent = await new NFTIntentParser().parse('Find ocean NFT under 1 SOL')
  const all = await new MockNFTProvider().search(intent)
  const eligible = all.filter(candidate => candidate.id === 'blue-tide' || candidate.id === 'forest-canopy')
    .map(candidate => ({ ...candidate, relevance: candidate.id === 'blue-tide' ? 0.8 : 0.4 }))
  const ranker = new NFTAcquisitionRanker(acquisitionRankingConfig({ NFT_SCORE_WEIGHT_INTENT: '0.4',
    NFT_SCORE_WEIGHT_PREFERENCE: '0.1', NFT_SCORE_WEIGHT_VISUAL: '0.1', NFT_SCORE_WEIGHT_RARITY: '0.1',
    NFT_SCORE_WEIGHT_MARKET: '0.2', NFT_SCORE_WEIGHT_PRICE: '0.1', NFT_MIN_ACQUISITION_SCORE: '0',
    NFT_MIN_ACQUISITION_CONFIDENCE: '0' }))
  const selected = ranker.select(eligible, intent)
  assert.equal(selected?.candidate.id, 'blue-tide')
  assert.equal(selected?.ranking.components.rarity, null)
  assert.ok((selected?.ranking.confidence ?? 100) < 100)
  assert.ok((await new DiscoveryEngine([new MockNFTProvider()]).search(intent)).candidates.length <= 1)
  assert.throws(() => acquisitionRankingConfig({ NFT_SCORE_WEIGHT_INTENT: '2' }), /total 1/)
})
test('semantic parser cannot raise explicit SOL authority; ranking rejects mismatches and over budget', async () => {
  const parser = new NFTIntentParser({ isConfigured: () => true, generate: async () => ({ content: JSON.stringify({ semanticQuery: 'ocean sea marine beach', terms: ['ocean', 'sea', 'marine', 'beach'] }), provider: 'fixture', model: 'fixture', latencyMs: 0 }) })
  const intent = await parser.parse('Find me an ocean-themed NFT under 1 SOL.')
  assert.equal(intent.maximumLamports, '999999999')
  assert.equal(intent.parser, 'llm')
  const result = await new DiscoveryEngine([new MockNFTProvider()]).search(intent)
  assert.deepEqual(result.candidates.map(c => c.id), ['blue-tide'])
  assert.ok(result.ranking)
  assert.equal(result.candidates[0].sourceNetwork, 'mock')
  assert.equal((await new DiscoveryEngine([new MockNFTProvider()]).search({ ...intent, maximumLamports: '100' })).candidates.length, 0)
  assert.equal((await new DiscoveryEngine([new MockNFTProvider()]).search({ ...intent, terms: ['shoes'] })).candidates.length, 0)
  await assert.rejects(parser.parse('Find ocean NFT under 1 SOL and under 2 SOL'))
  const literal = await new NFTIntentParser().parse('tui cần mua tranh NFT về giày dưới 0.5 SOL')
  assert.equal(literal.maximumLamports, '499999999')
  assert.ok(literal.terms.includes('giay'))
  assert.deepEqual(literalTerms('Tìm tranh NFT Collector Crypt để mua'), ['tranh', 'collector', 'crypt'])
  assert.equal((await new NFTIntentParser().parse('Mua NFT Collector Crypt ngân sách 1 SOL')).maximumLamports, '1000000000')
  assert.equal((await new NFTIntentParser().parse('Tìm NFT Collector Crypt tầm 0.5 SOL')).maximumLamports, '500000000')
  const buy = await new NFTIntentParser().parse('mua cho tui nft Kanpai_Pandas dưới 1 SOL hiếm nhất')
  assert.equal(buy.action, 'BUY')
  assert.deepEqual(buy.terms, ['kanpai', 'pandas'])
  assert.deepEqual(buy.priorities, ['rarity'])
  assert.equal((await new NFTIntentParser().parse('Find me an NFT artwork under 1 SOL.')).broadSearch, true)
})
test('marketplace failure/timeout cannot activate mock fallback or block other providers', async () => {
  const intent = await new NFTIntentParser().parse('Find ocean NFT under 1 SOL')
  const bad = { name: 'Broken', search: async () => { throw new Error('secret') }, refresh: async () => undefined }
  const result = await new DiscoveryEngine([bad]).search(intent)
  assert.equal(result.candidates.length, 0)
  assert.equal(result.status, 'DATA_UNAVAILABLE')
  assert.equal(result.sources[0].status, 'UNAVAILABLE')
  assert.equal(result.warnings.length, 1)
  assert.doesNotMatch(result.warnings.join(), /secret/)
  const slow = { ...bad, search: () => new Promise<never>(() => {}) }
  const mixed = await new DiscoveryEngine([slow, new MockNFTProvider()], 10).search(intent)
  assert.equal(mixed.candidates[0].id, 'blue-tide')
  assert.equal(mixed.status, 'MATCHED')
  assert.deepEqual(mixed.sources.map(source => source.status).sort(), ['AVAILABLE', 'UNAVAILABLE'])
  assert.equal((await new DiscoveryEngine([{ ...bad, search: async () => [] }]).search(intent)).status, 'NO_MATCH')
})
test('buy requests reject candidates without enough independent market and risk evidence', async () => {
  const intent = await new NFTIntentParser().parse('Buy ocean NFT under 1 SOL')
  const result = await new DiscoveryEngine([new MockNFTProvider()]).search(intent)
  assert.equal(result.status, 'NO_SAFE_PURCHASE')
  assert.deepEqual(result.candidates, [])
})
test('market history measures seven-day volume change from comparable snapshots', () => {
  const now = Date.now()
  const features = nftMarketFeaturesSchema.parse({ mint: 'mint', collection: 'kanpaipandas', priceSol: 0.5, volume7d: 20,
    observations: 10, coverage: 'partial', source: 'Magic Eden', observedAt: new Date(now).toISOString() })
  const prior = nftMarketFeaturesSchema.parse({ ...features, volume7d: 10, observedAt: new Date(now - 7 * 86400000).toISOString() })
  assert.equal(addMarketHistory(features, [prior]).volumeChange7d, 100)
})
test('most-bought objective uses sales counts rather than price or volume momentum', async () => {
  const intent = await new NFTIntentParser().parse('Find the most bought Retardio Cousins NFTs under 1 SOL')
  assert.equal(intent.investment?.objective, 'most_bought')
  assert.equal(intent.collectionQuery, 'Retardio Cousins')
  const features = nftMarketFeaturesSchema.parse({ mint: Keypair.generate().publicKey.toBase58(), collection: 'test',
    priceSol: 0.5, marketScope: 'mint', mintSales24h: 12, sales24h: 12, salesChange24h: -90, volumeChange24h: 500,
    observations: 12, coverage: 'complete', source: 'fixture', observedAt: new Date().toISOString() })
  const score = new NFTMomentumScorer().score(features, intent.investment!)
  assert.equal(score.signals[0].name, 'sales')
  assert.equal(score.signals[0].value, 12)
  assert.equal(score.directionalSignals, 1)
  const collectionOnly = nftMarketFeaturesSchema.parse({ ...features, marketScope: 'collection', mintSales24h: undefined })
  assert.equal(new NFTMomentumScorer().score(collectionOnly, intent.investment!).momentum, null)
})
test('investment results distinguish provider outage, successful empty search, and insufficient market evidence', async () => {
  const intent = await new NFTIntentParser().parse('Find the NFT with strongest momentum under 1 SOL')
  const root = await mkdtemp(join(tmpdir(), 'na-market-ranking-'))
  const snapshots = new NFTSnapshotStore(new FileAssetStore(join(root, 'snapshots')),
    new FileAssetStore(join(root, 'predictions')), new FileAssetStore(join(root, 'results')), false)
  const service = new NFTRankingService(snapshots)
  const unavailable = await service.search(intent, [{ name: 'Offline', search: async () => { throw new Error('private error') },
    refresh: async () => undefined }])
  assert.equal(unavailable.status, 'DATA_UNAVAILABLE')
  assert.equal(unavailable.sources[0].status, 'UNAVAILABLE')
  assert.doesNotMatch(unavailable.warnings.join(' '), /private error/)
  const empty = await service.search(intent, [{ name: 'Empty', search: async () => [], refresh: async () => undefined }])
  assert.equal(empty.status, 'NO_MATCH')
  const candidate = { ...(await new MockNFTProvider().search(intent))[0], sourceNetwork: 'mainnet' as const }
  const inadequate = await service.search(intent, [{ name: 'Listings only', search: async () => [candidate],
    refresh: async () => undefined }])
  assert.equal(inadequate.status, 'INSUFFICIENT_DATA')
  assert.equal(inadequate.sources[0].status, 'AVAILABLE')
})
