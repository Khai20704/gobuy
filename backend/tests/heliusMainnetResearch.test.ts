import test from 'node:test'
import assert from 'node:assert/strict'
import { Keypair } from '@solana/web3.js'
import { discoveryReplySchema, type NFTCandidate } from '@gobuy/shared'
import { HeliusMainnetResearchProvider } from '../src/services/acquisition/HeliusMainnetResearchProvider.js'
import { collectionRegistry } from '../src/services/acquisition/collectionRegistry.js'
import { NFTIntentParser, DiscoveryEngine } from '../src/services/acquisition/discovery.js'
import { AcquisitionService } from '../src/services/acquisition/AcquisitionService.js'
import { DevnetSimulationExecutor } from '../src/services/acquisition/ExecutionEngine.js'
import { TensorDevnetExecutor } from '../src/services/acquisition/TensorDevnetExecutor.js'
import { HeliusClient } from '../src/nft/helius/HeliusClient.js'

const collectionId = collectionRegistry[0].collectionId
function fixture(wrongName = false) {
  const calls: string[] = []
  const provider = new HeliusMainnetResearchProvider({ call: async <T>(method: string, params: unknown): Promise<T> => {
    calls.push(method)
    const asset = { id: collectionId, interface: 'ProgrammableNFT', burnt: false, content: { metadata: { name: wrongName ? 'Impostor' : 'y00ts' } }, grouping: [] }
    if (method === 'getAsset') return asset as T
    assert.deepEqual(params, { groupKey: 'collection', groupValue: collectionId, page: 1, limit: 20, options: { showUnverifiedCollections: false } })
    return { items: [{ ...asset, id: Keypair.generate().publicKey.toBase58(), content: { metadata: { name: 'y00t #1' } },
      grouping: [{ group_key: 'collection', group_value: collectionId }] }] } as T
  } })
  return { provider, calls }
}

test('y00ts and yoots resolve through Helius, reuse cached data and never create purchasable candidates', async () => {
  const { provider, calls } = fixture()
  let llmCalls = 0
  const parser = new NFTIntentParser({ isConfigured: () => true, generate: async () => { llmCalls++; throw new Error('No LLM required') } })
  const service = new AcquisitionService(new DiscoveryEngine([provider]), parser, undefined, undefined,
    { get: async () => undefined, put: async () => undefined } as never,
    undefined, undefined, undefined, undefined, undefined, { apply: async (_user: string, intent: unknown) => intent } as never)
  for (const text of ['Mua NFT rẻ nhất của collection y00ts', 'Find yoots', 'Find y00ts worth buying']) {
    const reply = discoveryReplySchema.parse(await service.discover('test-user', text))
    assert.equal(reply.research?.network, 'mainnet')
    assert.equal(reply.research?.collectionId, collectionId)
    assert.equal(reply.research?.priceSource, 'unavailable')
    assert.equal(reply.research?.assets.length, 1)
    assert.deepEqual(reply.candidates, [])
    assert.match(reply.message, /MAINNET.*không mua được/)
    assert.ok(reply.warnings.every(w => !w.includes('AI đang tạm gián đoạn')))
  }
  assert.equal(llmCalls, 0)
  assert.deepEqual(calls, ['getAsset', 'getAssetsByGroup'])
})

test('unknown names and mismatched identity never claim a verified Mainnet collection', async () => {
  const parser = new NFTIntentParser()
  const f = fixture()
  const result = await new DiscoveryEngine([f.provider]).search(await parser.parse('Find collection unknown_project'))
  assert.equal(result.status, 'COLLECTION_UNRESOLVED')
  assert.equal(result.research?.verified, false)
  assert.deepEqual(f.calls, [])
  const mismatch = await fixture(true).provider.search(await parser.parse('Find y00ts'), AbortSignal.timeout(1000))
  assert.equal(mismatch.status, 'COLLECTION_UNRESOLVED')
})

test('Mainnet is blocked at direct simulation and Tensor construction entrypoints', async () => {
  const candidate = { sourceNetwork: 'mainnet', provider: 'mock' } as NFTCandidate
  let builds = 0
  const simulation = new DevnetSimulationExecutor({ prepareRepresentation: () => { builds++ } } as never)
  assert.throws(() => simulation.prepare('id', candidate, 1, 'owner', 'user'), /MAINNET_READ_ONLY/)
  await assert.rejects(TensorDevnetExecutor.prototype.prepare.call({} as never, 'id', candidate, 1, 'owner', 'user'), /MAINNET_READ_ONLY/)
  assert.equal(builds, 0)
})

test('Mainnet Helius client allows only read methods and ignores Devnet endpoint configuration', async () => {
  let calls = 0
  const client = new HeliusClient({ HELIUS_API_KEY: 'fixture', HELIUS_NETWORK: 'devnet' }, async input => {
    calls++
    assert.equal(new URL(String(input)).hostname, 'mainnet.helius-rpc.com')
    return Response.json({ jsonrpc: '2.0', id: 'gobuy', result: {} })
  }, 1000, 'mainnet')
  await client.call('getAsset', { id: collectionId })
  await assert.rejects(client.call('sendTransaction', []), /MAINNET_READ_ONLY/)
  assert.equal(calls, 1)
})
const degods = collectionRegistry.find(entry => entry.name === 'DeGods')
function degodsFixture(name = 'DeGods') {
  const calls: string[] = []
  const provider = new HeliusMainnetResearchProvider({ call: async <T>(method: string, params: unknown): Promise<T> => {
    calls.push(method)
    const asset = { id: degods!.collectionId, interface: 'V1_NFT', burnt: false, content: { metadata: { name } }, grouping: [] }
    if (method === 'getAsset') return asset as T
    assert.deepEqual(params, { groupKey: 'collection', groupValue: degods!.collectionId, page: 1, limit: 20, options: { showUnverifiedCollections: false } })
    return { items: [{ ...asset, id: Keypair.generate().publicKey.toBase58(), content: { metadata: { name: 'DeGod #1' } },
      grouping: [{ group_key: 'collection', group_value: degods!.collectionId }] }] } as T
  } })
  return { provider, calls }
}

test('DeGods is a verified registry entry, so the same phrasing that works for y00ts never asks for a budget', async () => {
  assert.ok(degods, 'DeGods must stay in the verified collection registry')
  assert.match(degods.collectionId, /^[1-9A-HJ-NP-Za-km-z]{32,44}$/)
  // The resolver looks aliases up after lowercasing and replacing spaces with underscores.
  for (const alias of degods.aliases) assert.equal(alias, alias.toLowerCase().replace(/\s+/g, '_'))
  assert.ok(degods.aliases.includes('degods'))
  const intent = await new NFTIntentParser().parse('Mua nft rẻ nhất của collections DeGods')
  assert.equal(intent.priceDiscoveryOnly, true)
  assert.equal(intent.collectionQuery, 'DeGods')
  assert.equal(intent.objective, 'LOWEST_PRICE')
  const { provider, calls } = degodsFixture()
  const result = await new DiscoveryEngine([provider]).search(intent)
  assert.equal(result.status, 'INSUFFICIENT_MARKET_DATA')
  assert.equal(result.research?.collectionId, degods.collectionId)
  assert.equal(result.research?.collection, 'DeGods')
  assert.equal(result.research?.verified, true)
  assert.equal(result.research?.assets.length, 1)
  assert.match(result.research?.resolverSource ?? '', /nfw\.fun/)
  assert.deepEqual(result.candidates, [])
  assert.deepEqual(calls, ['getAsset', 'getAssetsByGroup'])
  // A collection asset that does not carry the registered name is never claimed as verified.
  assert.equal((await degodsFixture('Impostor').provider.search(intent, AbortSignal.timeout(1000))).status, 'COLLECTION_UNRESOLVED')
})
