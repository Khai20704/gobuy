import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Keypair } from '@solana/web3.js'
import { DEVNET_GENESIS, solanaConfig } from '@gobuy/shared'
import { HeliusClient, HeliusError } from '../src/nft/helius/HeliusClient.js'
import { HeliusNFTProvider } from '../src/nft/helius/HeliusNFTProvider.js'
import { TensorMarketplaceClient, normalizeListing } from '../src/nft/tensor/TensorMarketplaceClient.js'
import { NFTIntentParser, DiscoveryEngine, acquisitionConfig } from '../src/services/acquisition/discovery.js'
import { TensorDevnetNFTProvider } from '../src/services/acquisition/TensorDevnetNFTProvider.js'
import { nftProviders } from '../src/services/acquisition/providers.js'
import { NFTAcquisitionRanker } from '../src/services/acquisition/NFTAcquisitionRanker.js'

const mint = Keypair.generate().publicKey.toBase58(), seller = Keypair.generate().publicKey.toBase58()
const env = { HELIUS_API_KEY: 'test-secret', HELIUS_NETWORK: 'devnet' }
const raw = { id: mint, interface: 'V1_NFT', burnt: false, compression: { compressed: false },
  ownership: { owner: seller, ownership_model: 'single' }, content: { metadata: { name: 'Ocean painting',
    description: 'Digital art', attributes: [{ trait_type: 'Medium', value: 'Painting' }] } } }
const rpc = (result: unknown) => Response.json({ jsonrpc: '2.0', id: 'gobuy', result })
const fetcher = (asset: unknown = raw, owner = seller): typeof fetch => async (_url, init) => {
  const request = JSON.parse(String(init?.body))
  return rpc(request.method === 'getGenesisHash' ? DEVNET_GENESIS : request.method === 'getAsset' ? asset
    : { value: [{ account: { data: { parsed: { info: { mint, owner, tokenAmount: { amount: '1', decimals: 0 } } } } } }] })
}
test('Helius validates Devnet, DAS NFT and current owner without inventing optional metadata', async () => {
  const provider = new HeliusNFTProvider(new HeliusClient(env, fetcher()))
  const asset = await provider.verifyOwner(mint, seller)
  assert.equal(asset.network, 'devnet'); assert.equal(asset.name, 'Ocean painting')
  assert.equal(asset.collectionName, undefined); assert.equal(asset.image, undefined)
  assert.deepEqual(asset.attributes, [{ name: 'Medium', value: 'Painting' }])
  await assert.rejects(provider.verifyOwner(mint, Keypair.generate().publicKey.toBase58()), /LISTING_CHANGED/)
  await assert.rejects(new HeliusNFTProvider(new HeliusClient(env, fetcher(raw, mint))).verifyOwner(mint, seller), /LISTING_CHANGED/)
  await assert.rejects(new HeliusNFTProvider(new HeliusClient(env, fetcher(null))).getAsset(mint), /ASSET_NOT_FOUND/)
  await assert.rejects(new HeliusNFTProvider(new HeliusClient(env, fetcher({ id: mint }))).getAsset(mint), /INVALID_RESPONSE/)
})

test('Helius optional null description and attributes normalize before candidate/quote validation', async () => {
  const asset = await new HeliusNFTProvider(new HeliusClient(env, fetcher({ ...raw,
    content: { metadata: { name: 'Bodega Monke #5', description: null, attributes: null } },
  }))).verifyOwner(mint, seller)
  assert.equal(asset.description, '')
  assert.deepEqual(asset.attributes, [])
  assert.equal(asset.collectionAddress, undefined)
})
test('Helius failures are typed and never contain credential-bearing transport errors', async () => {
  for (const [status, code] of [[401, 'AUTH_FAILED'], [403, 'AUTH_FAILED'], [429, 'RATE_LIMITED'], [503, 'NETWORK_ERROR']] as const) {
    await assert.rejects(new HeliusClient(env, async () => new Response(null, { status })).call('getAsset', {}),
      (error: unknown) => error instanceof HeliusError && error.code === code && !String(error).includes('test-secret'))
  }
  await assert.rejects(new HeliusClient(env, async () => { throw new Error('test-secret') }).call('getAsset', {}), /NETWORK_ERROR/)
  await assert.rejects(new HeliusClient(env, async () => Response.json({})).call('getAsset', {}), /INVALID_RESPONSE/)
  const signal = AbortSignal.abort()
  await assert.rejects(new HeliusClient(env, async (_url, init) => { init?.signal?.throwIfAborted(); return rpc(null) }).call('getAsset', {}, signal), /TIMEOUT/)
  await assert.rejects(new HeliusClient(env, async () => rpc('mainnet')).assertDevnet(), /NETWORK_MISMATCH/)
  await assert.rejects(new HeliusClient({ ...env, HELIUS_NETWORK: 'mainnet' }).call('getAsset', {}), /NETWORK_MISMATCH/)
})
test('active NFT factory has no Magic Eden dependency and network mismatch fails closed', () => {
  assert.deepEqual(nftProviders({}).map(provider => provider.name), ['tensor', 'helius-mainnet-research'])
  assert.equal(acquisitionConfig({}).DISCOVERY_NETWORK, 'devnet')
  assert.equal(acquisitionConfig({ HELIUS_API_KEY: ' test-secret ' }).heliusConfigured, true)
  assert.equal(acquisitionConfig({}).heliusConfigured, false)
  assert.throws(() => acquisitionConfig({ HELIUS_NETWORK: 'mainnet' }))
  assert.throws(() => acquisitionConfig({ DISCOVERY_NETWORK: 'mainnet' }))
  assert.throws(() => acquisitionConfig({ DEMO_MODE: 'false' }))
  assert.throws(() => solanaConfig({ DEMO_MODE: 'true', SOLANA_EXECUTION_NETWORK: 'mainnet' }), /GoBuy demo/)
})
test('Vietnamese art buy keeps BEST_OVERALL while search cannot grant purchase authority', async () => {
  const parser = new NFTIntentParser()
  const buy = await parser.parse('Mua tranh NFT dưới 1 SOL đáng mua nhất')
  assert.equal(buy.action, 'BUY'); assert.equal(buy.objective, 'BEST_OVERALL'); assert.equal(buy.maxPriceSol, 1)
  assert.ok(buy.terms.includes('tranh')); assert.ok(buy.terms.includes('painting'))
  assert.equal((await parser.parse('Tìm tranh NFT dưới 1 SOL')).action, 'SEARCH')
  assert.equal((await parser.parse('Mua NFT dưới 1 SOL')).objective, 'BEST_OVERALL')
})
const listing = { listState: Keypair.generate().publicKey.toBase58(), mint, seller, priceLamports: '800000000', expiry: '0', name: '', symbol: '' }
test('Tensor purchase plan refuses disappeared, changed seller/mint/price and wrong network', async () => {
  const intent = await new NFTIntentParser().parse('Mua NFT dưới 1 SOL')
  let current: typeof listing | undefined = listing
  let builds = 0
  const client = new TensorMarketplaceClient('https://api.devnet.solana.com', async () => ({ listings: [listing], scanned: 1,
    activeSolListings: 1, metadataMissing: 0, unsupportedStandards: 0 }), async () => current, async () => {
    builds++; return { ...listing, programAddress: 'test', accounts: [], data: new Uint8Array() }
  })
  const result = await client.searchListings(intent, AbortSignal.timeout(1000))
  assert.equal(result.status, 'SUCCESS'); assert.equal(result.listings[0].priceLamports, '800000000')
  const normalized = normalizeListing(listing), signal = AbortSignal.timeout(1000)
  assert.equal((await client.buildPurchase(normalized, seller, signal)).instructions.length, 1)
  for (const [change, code] of [[{ seller: mint }, 'LISTING_CHANGED'], [{ mint: seller }, 'LISTING_CHANGED'], [{ priceLamports: '1300000000' }, 'PRICE_CHANGED']] as const) {
    current = { ...listing, ...change }
    await assert.rejects(client.buildPurchase(normalized, seller, signal), new RegExp(code))
  }
  current = undefined
  assert.equal(await client.refreshListing(listing.listState, signal), null)
  await assert.rejects(client.buildPurchase(normalized, seller, signal), /LISTING_UNAVAILABLE/)
  await assert.rejects(client.buildPurchase({ ...normalized, network: 'mainnet' as 'devnet' }, seller, signal), /NETWORK_MISMATCH/)
  assert.equal(builds, 1)
})
test('Helius outage yields DATA_UNAVAILABLE without synthesized candidates', async () => {
  const provider = new TensorDevnetNFTProvider('https://api.devnet.solana.com', async () => ({ listings: [listing], scanned: 1,
    activeSolListings: 1, metadataMissing: 0, unsupportedStandards: 0 }), undefined,
  { verifyOwner: async () => { throw new HeliusError('RATE_LIMITED') } })
  const result = await new DiscoveryEngine([provider]).search(await new NFTIntentParser().parse('Mua NFT dưới 1 SOL'))
  assert.equal(result.status, 'DATA_UNAVAILABLE'); assert.deepEqual(result.candidates, [])
})
test('Tensor BEST_OVERALL can prefer stronger metadata over the cheapest listing; missing rarity cannot be fabricated', async () => {
  const intent = await new NFTIntentParser().parse('Mua tranh NFT dưới 1 SOL đáng mua nhất')
  const provider = new TensorDevnetNFTProvider('https://api.devnet.solana.com', async () => ({ listings: [listing], scanned: 1,
    activeSolListings: 1, metadataMissing: 0, unsupportedStandards: 0 }), undefined,
  { verifyOwner: async () => ({ mint, owner: listing.listState, name: 'Ocean painting', network: 'devnet', verifiedAt: new Date().toISOString() }) })
  const [candidate] = await provider.search(intent, AbortSignal.timeout(1000))
  const relevant = { ...candidate, id: 'relevant', relevance: 1, listing: { ...candidate.listing, priceLamports: '600000000' } }
  const cheap = { ...candidate, id: 'cheap', relevance: 0.1, listing: { ...candidate.listing, priceLamports: '500000000' } }
  const ranker = new NFTAcquisitionRanker()
  assert.equal(ranker.select([cheap, relevant], intent)?.candidate.id, 'relevant')
  assert.equal(ranker.select([cheap, relevant], { ...intent, objective: 'LOWEST_PRICE' })?.candidate.id, 'cheap')
  assert.equal(ranker.select([candidate], { ...intent, objective: 'RARITY' }), undefined)
  assert.equal(ranker.rank(candidate, intent).ranking.components.rarity, null)
})
test('Helius authentication failure tells the user what to fix, without leaking credentials', async () => {
  const provider = new TensorDevnetNFTProvider(undefined, undefined, undefined, {
    verifyNetwork: async () => { throw new HeliusError('AUTH_FAILED') },
    verifyOwner: async () => { throw new Error('must not read assets') },
  })
  const reply = await new DiscoveryEngine([provider]).search(await new NFTIntentParser().parse('Find ocean NFT under 1 SOL'))
  assert.equal(reply.status, 'DATA_UNAVAILABLE')
  assert.equal(reply.sources[0].code, 'AUTHENTICATION_FAILED')
  assert.match(reply.warnings.join(' '), /Helius.*401\/403/)
  assert.doesNotMatch(JSON.stringify(reply), /test-secret/)
})
test('Tensor verifies escrow custody rather than requiring the seller to retain the NFT', async () => {
  const provider = new TensorDevnetNFTProvider('https://api.devnet.solana.com', async () => ({ listings: [listing], scanned: 1,
    activeSolListings: 1, metadataMissing: 0, unsupportedStandards: 0 }), async () => listing,
  { verifyOwner: async (requestedMint, custodian) => {
    assert.equal(requestedMint, mint)
    assert.equal(custodian, listing.listState)
    assert.notEqual(custodian, seller)
    return { mint, owner: custodian, name: 'Ocean art', network: 'devnet', verifiedAt: new Date().toISOString() }
  } })
  const intent = await new NFTIntentParser().parse('Find ocean NFT under 1 SOL')
  const result = await new DiscoveryEngine([provider]).search(intent)
  assert.equal(result.status, 'MATCHED')
  assert.equal(result.candidates[0].asset?.owner, listing.listState)
  assert.equal(result.candidates[0].listing.seller, seller)
  assert.ok(await provider.refresh(result.candidates[0], AbortSignal.timeout(1000)))
  assert.equal(new NFTAcquisitionRanker().select([{ ...result.candidates[0],
    asset: { ...result.candidates[0].asset!, owner: seller } }], intent), undefined)
})
test('Helius retries transient read failures once but never retries writes or auth failures', async () => {
  let calls = 0
  const client = new HeliusClient(env, async () => {
    if (++calls === 1) throw new TypeError('connection reset')
    return rpc(DEVNET_GENESIS)
  })
  await client.assertDevnet(); assert.equal(calls, 2)
  calls = 0
  const failed = new HeliusClient(env, async () => { calls++; throw new TypeError('connection reset') })
  await assert.rejects(failed.call('sendTransaction', []), /NETWORK_ERROR/); assert.equal(calls, 1)
  calls = 0
  const denied = new HeliusClient(env, async () => { calls++; return new Response(null, { status: 401 }) })
  await assert.rejects(denied.call('getAsset', {}), /AUTH_FAILED/); assert.equal(calls, 1)
})
