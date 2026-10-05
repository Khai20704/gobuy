import assert from 'node:assert/strict'
import { test } from 'node:test'
import { generateKeyPairSync, sign } from 'node:crypto'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Keypair, PublicKey } from '@solana/web3.js'
import type { NftDemoReceipt, AssetPosition, NFTCandidate } from '@gobuy/shared'
import { FileAssetStore } from '../src/persistence/AssetStore.js'
import { WalletAssociationService } from '../src/services/acquisition/WalletAssociationService.js'
import { PortfolioService } from '../src/services/acquisition/PortfolioService.js'
import { AcquisitionService } from '../src/services/acquisition/AcquisitionService.js'
import { DiscoveryEngine, NFTIntentParser } from '../src/services/acquisition/discovery.js'
import { MockNFTProvider } from '../src/services/acquisition/MockNFTProvider.js'
import type { ExecutionEngine } from '../src/services/acquisition/ExecutionEngine.js'
import type { NaConversationState } from '../src/services/acquisition/NaConversationContext.js'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'na-assets-'))
  const keys = generateKeyPairSync('ed25519')
  const address = new PublicKey(keys.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32)).toBase58()
  let now = Date.now()
  const wallets = new WalletAssociationService(new FileAssetStore(join(root, 'wallets')), new FileAssetStore(join(root, 'challenges')), () => now)
  return { root, keys, address, wallets, advance: () => { now += 301000 } }
}
test('wallet proof is account-bound, signature-verified, expiring, single-use and survives reload', async () => {
  const f = await fixture()
  await assert.rejects(f.wallets.require('alice', f.address))
  const challenge = await f.wallets.challenge('alice', f.address)
  const signature = sign(null, Buffer.from(challenge.message), f.keys.privateKey).toString('base64')
  await assert.rejects(f.wallets.verify('bob', challenge.id, signature))
  await f.wallets.verify('alice', challenge.id, signature)
  await f.wallets.require('alice', f.address)
  await assert.rejects(f.wallets.verify('alice', challenge.id, signature))
  await assert.rejects(f.wallets.require('bob', f.address))
  const wrong = await f.wallets.challenge('alice', f.address)
  await assert.rejects(f.wallets.verify('alice', wrong.id, Buffer.alloc(64).toString('base64')))
  const expired = await f.wallets.challenge('alice', f.address); f.advance()
  await assert.rejects(f.wallets.verify('alice', expired.id, signature))
  const reloaded = new WalletAssociationService(new FileAssetStore(join(f.root, 'wallets')), new FileAssetStore(join(f.root, 'challenges')))
  assert.equal((await reloaded.list('alice'))[0].address, f.address)
  assert.deepEqual(await reloaded.list('bob'), [])
})
test('asset store consumes a nonce once under concurrent calls', async () => {
  const store = new FileAssetStore<{ nonce: string }>(await mkdtemp(join(tmpdir(), 'nonce-race-')))
  await store.put('alice', 'nonce', { nonce: 'one' }, true)
  const results = await Promise.all([store.take('alice', 'nonce'), store.take('alice', 'nonce')])
  assert.equal(results.filter(Boolean).length, 1)
})
test('portfolio records confirmed simulation once, tracks chain ownership, never values it as mainnet', async () => {
  const f = await fixture()
  let owner = f.address
  const store = new FileAssetStore<AssetPosition>(join(f.root, 'portfolio'))
  const portfolio = new PortfolioService({ assetOwner: async () => owner }, store)
  const source = { ...(await new MockNFTProvider().search({} as never))[0], sourceNetwork: 'mainnet' as const, mint: Keypair.generate().publicKey.toBase58() }
  const id = crypto.randomUUID(), receipt: NftDemoReceipt = { status: 'CONFIRMED', message: 'ok', asset: Keypair.generate().publicKey.toBase58(), signature: 'tx', totalLamports: 120000000 }
  await portfolio.record('alice', id, f.address, source, { ...receipt, status: 'PENDING' })
  assert.deepEqual(await portfolio.list('alice'), [])
  await portfolio.record('alice', id, f.address, source, receipt)
  await portfolio.record('alice', id, f.address, source, receipt)
  const positions = await portfolio.list('alice')
  assert.equal(positions.length, 1)
  assert.equal(positions[0].ownership, 'verified')
  assert.notEqual(positions[0].sourceAsset.mint, positions[0].execution.mint)
  assert.equal(positions[0].execution.simulated, true)
  assert.equal(positions[0].valuation.estimatedMarketValue, null)
  assert.equal(positions[0].valuation.unrealizedPnL, null)
  assert.deepEqual(await portfolio.list('bob'), [])
  owner = 'another-owner'
  assert.equal((await portfolio.list('alice'))[0].ownership, 'not_owned')
  const offline = new PortfolioService({ assetOwner: async () => { throw new Error('RPC offline') } }, store)
  assert.equal((await offline.list('alice'))[0].ownership, 'unknown')
})
test('acquisition accepts a directly connected wallet, enforces source isolation and repricing; pending never resubmits', async () => {
  const f = await fixture()
  const provider = new MockNFTProvider()
  let sends = 0, receipt: NftDemoReceipt = { status: 'NOT_SUBMITTED', message: '' }
  const executor: ExecutionEngine = {
    prepare: async () => ({ status: 'NO_MATCH', message: 'fixture' }),
    submit: async () => { sends++; return receipt = { status: 'PENDING', message: 'unknown', signature: 'tx' } },
    status: async () => receipt, assetOwner: async () => f.address,
  }
  const service = new AcquisitionService(new DiscoveryEngine([provider]), new NFTIntentParser(), f.wallets, executor,
    new FileAssetStore(join(f.root, 'discoveries')), new FileAssetStore(join(f.root, 'acquisitions')),
    new FileAssetStore<NFTCandidate>(join(f.root, 'metadata')), new PortfolioService(executor, new FileAssetStore(join(f.root, 'positions'))))
  const discovery = await service.discover('alice', 'Find ocean NFT under 1 SOL')
  const candidate = discovery.candidates[0]
  await assert.rejects(service.prepare('alice', discovery.id, 'invented', f.address))
  await service.prepare('alice', discovery.id, candidate.id, f.address)
  await assert.rejects(service.submit('bob', discovery.id, 'signed'))
  const refresh = provider.refresh.bind(provider)
  provider.refresh = async c => { const current = await refresh(c); return current ? { ...current, listing: { ...current.listing, priceLamports: '900000000' } } : undefined }
  await assert.rejects(service.submit('alice', discovery.id, 'signed'), /PRICE_CHANGED/)
  assert.equal(sends, 0)
  provider.refresh = refresh
  assert.equal((await service.submit('alice', discovery.id, 'signed')).status, 'PENDING')
  assert.equal((await service.submit('alice', discovery.id, 'signed')).status, 'PENDING')
  assert.equal(sends, 1)
  assert.deepEqual(await service.portfolio.list('alice'), [])
})

test('acquisition conversation survives service reload and finds another single candidate', async () => {
  const f = await fixture(), conversationId = crypto.randomUUID()
  const conversations = new FileAssetStore<NaConversationState>(join(f.root, 'conversations'))
  const candidates = (await new MockNFTProvider().search({} as never)).map(candidate => ({
    ...candidate, mint: Keypair.generate().publicKey.toBase58(),
  }))
  const provider = { name: 'Conversation Fixtures', search: async () => candidates, refresh: async () => undefined }
  const createService = () => new AcquisitionService(new DiscoveryEngine([provider]), new NFTIntentParser(),
    f.wallets, undefined, new FileAssetStore(join(f.root, 'discoveries')), new FileAssetStore(join(f.root, 'acquisitions')),
    new FileAssetStore<NFTCandidate>(join(f.root, 'metadata')), undefined, conversations)

  const first = await createService().discover('alice', 'Find me an NFT artwork under 1 SOL', crypto.randomUUID(), conversationId)
  assert.equal(first.candidates.length, 1)
  const firstMint = first.candidates[0].mint

  const second = await createService().discover('alice', 'Find another.', crypto.randomUUID(), conversationId)
  assert.equal(second.candidates.length, 1)
  assert.notEqual(second.candidates[0].mint, firstMint)
  assert.ok(second.intent.excludedMints.includes(firstMint!))
})
