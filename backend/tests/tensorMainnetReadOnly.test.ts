import test from 'node:test'
import assert from 'node:assert/strict'
import { Keypair } from '@solana/web3.js'
import { TensorMainnetReadOnlyProvider } from '../src/services/acquisition/TensorMainnetReadOnlyProvider.js'
import { DiscoveryEngine, NFTIntentParser } from '../src/services/acquisition/discovery.js'
import { AcquisitionService } from '../src/services/acquisition/AcquisitionService.js'

const parser = new NFTIntentParser()
const mint = Keypair.generate().publicKey.toBase58(), seller = Keypair.generate().publicKey.toBase58()
const collection = { collId: 'tensor-collection-id', name: 'y00ts', slugDisplay: 'y00ts', tensorVerified: true, hidden: false, flagReason: null }
const listing = { mint, name: 'y00ts #1', listing: { price: '760000000', seller, currency: null } }
test('missing Tensor key explains configuration before retry and never calls Tensor', async () => {
  let calls = 0
  const provider = new TensorMainnetReadOnlyProvider('', async () => { calls++; throw new Error('Unexpected request') })
  const service = new AcquisitionService(new DiscoveryEngine([provider]), parser, undefined, undefined,
    { get: async () => undefined, put: async () => undefined } as never,
    undefined, undefined, undefined, undefined, undefined,
    { apply: async (_user: string, intent: unknown) => intent } as never)
  const reply = await service.discover('test-user', 'Mua NFT rẻ nhất của collection y00ts')
  assert.equal(calls, 0)
  assert.equal(reply.status, 'DATA_UNAVAILABLE')
  assert.deepEqual(reply.candidates, [])
  assert.match(reply.message, /TENSOR_API_KEY/)
  assert.match(reply.message, /khởi động lại backend trước khi/)
  assert.match(reply.message, /không cho phép mua/)
  assert.doesNotMatch(reply.message, /theo ngân sách/)
})
function fixture(rows: unknown[] = [listing]) {
  const urls: URL[] = []
  const provider = new TensorMainnetReadOnlyProvider('fixture-key', async (input, init) => {
    const url = new URL(String(input)); urls.push(url)
    assert.equal(init?.method, 'GET')
    assert.equal(url.hostname, 'api.mainnet.tensordev.io')
    assert.ok(!url.pathname.includes('/tx/'))
    return Response.json(url.pathname.endsWith('find_collection') ? collection : { mints: rows })
  })
  return { provider, urls }
}
test('Mainnet lookup resolves canonical collection ID then returns price with read-only eligibility', async () => {
  const f = fixture()
  const intent = await parser.parse('Mua NFT rẻ nhất collection y00ts')
  const result = await new DiscoveryEngine([f.provider]).search(intent)
  assert.equal(result.status, 'MATCHED')
  assert.equal(result.candidates[0].sourceNetwork, 'mainnet')
  assert.equal(result.candidates[0].purchaseEligibility?.reason, 'MAINNET_READ_ONLY')
  assert.equal(result.candidates[0].listing.priceLamports, '760000000')
  assert.equal(f.urls[1].searchParams.get('collId'), collection.collId)
  assert.equal(f.urls[1].searchParams.get('sortBy'), 'ListingPriceAsc')
  assert.equal(result.ranking, undefined)
})
test('highest-price requests use descending API order and do not require a budget', async () => {
  const f = fixture([listing, { ...listing, mint: Keypair.generate().publicKey.toBase58(), listing: { ...listing.listing, price: '1200000000' } }])
  const intent = await parser.parse('Tìm NFT đắt nhất collection y00ts')
  assert.equal(intent.objective, 'HIGHEST_PRICE')
  assert.equal(intent.priceDiscoveryOnly, true)
  const result = await new DiscoveryEngine([f.provider]).search(intent)
  assert.equal(f.urls[1].searchParams.get('sortBy'), 'ListingPriceDesc')
  assert.equal(result.candidates[0].listing.priceLamports, '1200000000')
})
test('missing credentials and malformed prices report unavailable, never invent a listing', async () => {
  const intent = await parser.parse('Tìm NFT rẻ nhất collection y00ts')
  const missing = await new DiscoveryEngine([new TensorMainnetReadOnlyProvider('')]).search(intent)
  assert.equal(missing.status, 'DATA_UNAVAILABLE')
  assert.equal(missing.sources[0].code, 'AUTH_REQUIRED')
  const malformed = await new DiscoveryEngine([fixture([{ ...listing, listing: { ...listing.listing, price: '0.76' } }]).provider]).search(intent)
  assert.equal(malformed.status, 'DATA_UNAVAILABLE')
  assert.equal(malformed.candidates.length, 0)
})
test('Mainnet purchases reject server-side before refresh or executor, even without UI eligibility', async () => {
  const f = fixture()
  const intent = await parser.parse('Mua NFT rẻ nhất collection y00ts under 1 SOL')
  const result = await f.provider.search(intent, new AbortController().signal)
  const candidate = { ...result.candidates[0], purchaseEligibility: undefined }
  const saved = { reply: { intent, candidates: [candidate], expiresAt: new Date(Date.now() + 60000).toISOString() } }
  const service = new AcquisitionService(new DiscoveryEngine([]), parser, undefined, undefined,
    { get: async () => saved } as never)
  await assert.rejects(service.prepare('user', crypto.randomUUID(), candidate.id, seller), /MAINNET_READ_ONLY/)
})
