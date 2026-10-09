process.env.NFT_DEMO_PUBLIC_URL = 'https://demo.gobuy.example'
process.env.NFT_DEMO_IMAGE_URL = 'https://demo.gobuy.example/demo.png'
// This file exercises the LEGACY DEMO autonomous flow on purpose. That flow is off by default for
// new orders (the genuine Tensor purchase replaces it), but its reconciliation machinery still ships
// for orders already on chain, so the tests opt in explicitly and one test below proves the default.
process.env.GOBUY_DEMO_AUTOPURCHASE_ENABLED = 'true'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID, createHash } from 'node:crypto'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BSON } from 'mongodb'
import { Keypair, SendTransactionError } from '@solana/web3.js'
import { DEVNET_GENESIS, autonomousNFTCandidateSchema, nftCandidateSchema, nftDemoQuoteSchema,
  type DiscoveryReply, type NFTCandidate, type WalletAssociation } from '@gobuy/shared'
import { FileAssetStore } from '../src/persistence/AssetStore.js'
import { AutonomousPurchaseService, type AutonomousPurchaseOrder } from '../src/services/acquisition/AutonomousPurchaseService.js'
import { AcquisitionService } from '../src/services/acquisition/AcquisitionService.js'
import { DiscoveryEngine, NFTIntentParser, evaluateCandidates } from '../src/services/acquisition/discovery.js'
import { WalletAssociationService } from '../src/services/acquisition/WalletAssociationService.js'
import { MandateProgramClient } from '../src/services/mandate/MandateProgramClient.js'
import { mandateAddress, mandateVaultAddress } from '../src/services/mandate/MandateGuard.js'
import { executeVaultSpend } from '../src/services/mandate/autonomousSpend.js'
import { SPEND_RECORD_DISCRIMINATOR } from '../src/services/mandate/spendRecords.js'
import { executeAutonomousPurchase } from '../../frontend/src/features/na/autonomousPurchase.js'
import { DeliveryService } from '../src/services/delivery/DeliveryService.js'

const key = () => Keypair.generate().publicKey.toBase58()
function candidate(): NFTCandidate {
  const mint = key(), seller = key(), listingId = key(), now = new Date().toISOString()
  return nftCandidateSchema.parse({ id: 'tensor:' + mint, provider: 'tensor', sourceNetwork: 'devnet', mint,
    name: 'Bodega Monke #5', description: '', image: null, collection: 'Bodega Monke', attributes: [],
    asset: { mint, owner: listingId, network: 'devnet', verifiedAt: now },
    marketplaceListing: { listingId, mint, seller, priceLamports: '40000000', currency: 'SOL', marketplace: 'Tensor', network: 'devnet', status: 'LISTED' },
    listing: { seller, priceLamports: '40000000', currency: 'SOL', observedAt: now, url: '' } })
}

test('optional quote metadata normalizes explicit null and undefined without relaxing execution data', () => {
  for (const metadata of [{ description: null }, { attributes: null }, { collectionAddress: null },
    { description: null, attributes: null, collectionAddress: null },
    { description: 'Art', attributes: [{ name: 'Color', value: 'Blue' }], collectionAddress: key() }]) {
    const source = candidate()
    const sourceAsset = { ...source, asset: { ...source.asset, ...metadata } }
    const parsed = nftDemoQuoteSchema.parse({ sourceAsset, id: randomUUID(), network: 'devnet', owner: key(), asset: source.mint,
      title: source.name, image: '', priceLamports: 40000000, maximumLamports: 1000000000,
      estimatedTotalLamports: 40000000, transaction: '', expiresAt: new Date().toISOString() })
    assert.equal(parsed.sourceAsset?.asset?.description, metadata.description ?? '')
    assert.deepEqual(parsed.sourceAsset?.asset?.attributes, metadata.attributes ?? [])
    assert.equal(parsed.sourceAsset?.asset?.collectionAddress, metadata.collectionAddress)
    assert.ok(autonomousNFTCandidateSchema.safeParse(parsed.sourceAsset).success)
  }
  // The Mongo driver defaults ignoreUndefined to false: reproduce the persisted nulls.
  const stored = BSON.deserialize(BSON.serialize({ asset: { description: undefined, attributes: undefined, collectionAddress: undefined } }, { ignoreUndefined: false }))
  assert.deepEqual(stored.asset, { description: null, attributes: null, collectionAddress: null })
  assert.equal(nftCandidateSchema.parse({ ...candidate(), asset: { ...candidate().asset, ...stored.asset } }).asset?.description, '')
  assert.equal(nftCandidateSchema.safeParse({ ...candidate(), asset: { ...candidate().asset, attributes: 'invalid' } }).success, false)
})

async function fixture(deliveries?: Pick<DeliveryService, 'deliver'>) {
  const root = await mkdtemp(join(tmpdir(), 'autonomous-purchase-'))
  const owner = Keypair.generate(), agent = Keypair.generate(), recipient = Keypair.generate(), program = Keypair.generate().publicKey
  const address = mandateAddress(program, owner.publicKey.toBase58()), vault = mandateVaultAddress(program, address)
  const mandate = { address: address.toBase58(), owner: owner.publicKey.toBase58(), executor: agent.publicKey.toBase58(),
    vault: vault.toBase58(), recipient: recipient.publicKey.toBase58(), active: true, closed: false,
    expiresAt: Math.floor(Date.now() / 1000) + 3600, allowedCategory: 'NFT' as 'NFT' | 'RWA',
    maxBudgetLamports: 1_000_000_000n, spentLamports: 0n, vaultLamports: 1_000_890_880n,
    createdAt: 0, closedAt: 0, status: 'ACTIVE' as const }
  const client = new MandateProgramClient(program, agent, recipient.publicKey, 'https://example.invalid')
  client.read = async () => mandate
  client.connection.getGenesisHash = async () => DEVNET_GENESIS
  client.connection.getLatestBlockhash = async () => ({ blockhash: key(), lastValidBlockHeight: 42 })
  let receiptData: Buffer | undefined, sends = 0, spendCalls = 0
  client.connection.getAccountInfo = async () => receiptData ? { data: receiptData, owner: program, lamports: 1, executable: false, rentEpoch: 0 } : null
  client.connection.getSignaturesForAddress = async () => [{ signature: '2'.repeat(88), slot: 1, err: null, memo: null }]
  client.confirm = async () => null
  client.broadcast = async transaction => {
    sends++
    assert.ok(transaction.verifySignatures())
    assert.deepEqual(transaction.signatures.map(slot => slot.publicKey.toBase58()), [agent.publicKey.toBase58()])
    assert.equal(transaction.feePayer?.toBase58(), agent.publicKey.toBase58())
    const ix = transaction.instructions[0]
    assert.deepEqual(ix.data.subarray(0, 8), createHash('sha256').update('global:spend_from_mandate').digest().subarray(0, 8))
    assert.equal(ix.data.readBigUInt64LE(8), 40_000_000n)
    assert.equal(ix.keys[3].pubkey.toBase58(), recipient.publicKey.toBase58())
    receiptData = Buffer.alloc(194)
    Buffer.from(SPEND_RECORD_DISCRIMINATOR, 'hex').copy(receiptData)
    address.toBuffer().copy(receiptData, 8); owner.publicKey.toBuffer().copy(receiptData, 40); recipient.publicKey.toBuffer().copy(receiptData, 72)
    ix.data.subarray(17, 33).copy(receiptData, 104); ix.data.subarray(33, 65).copy(receiptData, 120)
    receiptData.writeBigUInt64LE(40_000_000n, 152); receiptData.writeBigUInt64LE(0n, 160)
    receiptData.writeBigUInt64LE(40_000_000n, 168); receiptData.writeBigUInt64LE(960_000_000n, 176)
    receiptData[184] = 1; receiptData.writeBigInt64LE(BigInt(Math.floor(Date.now() / 1000)), 185)
    mandate.spentLamports = 40_000_000n; mandate.vaultLamports -= 40_000_000n
    return '2'.repeat(88)
  }
  const orders = new FileAssetStore<AutonomousPurchaseOrder>(join(root, 'orders'))
  const autonomous = new AutonomousPurchaseService(() => client, async (client, request) => {
    spendCalls++; assert.equal(request.amountLamports, 40_000_000n)
    return executeVaultSpend(client, request)
  }, orders)
  const walletsStore = new FileAssetStore<WalletAssociation>(join(root, 'wallets'))
  await walletsStore.put('alice', mandate.owner, { address: mandate.owner, verified: true, network: 'devnet', provider: 'phantom', createdAt: new Date().toISOString(), lastUsedAt: new Date().toISOString() })
  const wallets = new WalletAssociationService(walletsStore)
  const discoveries = new FileAssetStore<{ reply: DiscoveryReply; text: string }>(join(root, 'discoveries'))
  let fresh = candidate()
  let deliveryPhase: 'COMPLETED' | 'DELIVERY_FAILED' = 'COMPLETED'
  const service = new AcquisitionService(new DiscoveryEngine([{ name: 'tensor', search: async () => [fresh], refresh: async () => fresh }]),
    new NFTIntentParser(), wallets, undefined, discoveries, undefined, undefined, undefined, undefined, undefined, undefined, undefined, autonomous,
    deliveries ?? { deliver: async (_user, input) => ({ ...input, mint: input.sourceMint, quantity: '1', network: 'devnet', simulated: false,
      phase: deliveryPhase, ownership: deliveryPhase === 'COMPLETED' ? 'verified' : 'unknown', signature: 'delivery-fixture', message: 'Delivery fixture' }) })
  const discovery = await service.discover('alice', 'Buy any NFT under 1 SOL')
  return { owner: mandate.owner, service, client, mandate, discovery, candidate: fresh, orders, autonomous, discoveries,
    setDeliveryPhase: (value: typeof deliveryPhase) => { deliveryPhase = value },
    setFresh: (value: NFTCandidate) => { fresh = value }, sends: () => sends, spendCalls: () => spendCalls }
}

test('new purchase requires demo acceptance before spending', async () => {
  const f = await fixture()
  await assert.rejects(f.service.autonomousPurchase('alice', f.discovery.id, f.candidate.id, f.owner), /DEMO/)
  assert.equal(f.spendCalls(), 0)
})

test('a new order is refused outright while the legacy DEMO flow is disabled', async () => {
  const enabled = process.env.GOBUY_DEMO_AUTOPURCHASE_ENABLED
  delete process.env.GOBUY_DEMO_AUTOPURCHASE_ENABLED
  try {
    const f = await fixture()
    // Even a caller that accepted the demo cannot start a new DEMO order: it must use the genuine
    // purchase path, which pays the real listing instead of minting a GoBuy DEMO NFT.
    await assert.rejects(f.service.autonomousPurchase('alice', f.discovery.id, f.candidate.id, f.owner, true), /mua NFT gốc/)
    assert.equal(f.spendCalls(), 0)
    assert.equal(f.sends(), 0)
    assert.equal(await f.orders.get('alice', f.discovery.id), undefined)
  } finally {
    if (enabled === undefined) delete process.env.GOBUY_DEMO_AUTOPURCHASE_ENABLED
    else process.env.GOBUY_DEMO_AUTOPURCHASE_ENABLED = enabled
  }
})

test('accepted purchase queues automatically; restarted delivery signs without Phantom and never pays or mints twice', async (t) => {
  const previous = process.env.NFT_DEMO_PUBLIC_URL
  process.env.NFT_DEMO_PUBLIC_URL = 'https://metadata.example.com'
  t.after(() => { if (previous === undefined) delete process.env.NFT_DEMO_PUBLIC_URL; else process.env.NFT_DEMO_PUBLIC_URL = previous })
  const root = await mkdtemp(join(tmpdir(), 'automatic-demo-'))
  const stores = ['plans', 'attempts', 'completions', 'events', 'metadata', 'views'].map(name => new FileAssetStore<any>(join(root, name)))
  let prepared = 0, sent = 0, confirmed = false, now = Date.now()
  const chain = {
    prepare: async () => { prepared++; return { mint: 'demo-mint', signature: 'delivery-signature', wire: 'signed', lastValidBlockHeight: 10, standard: 'spl' as const } },
    inspect: async () => confirmed ? 'confirmed' as const : 'pending' as const,
    send: async () => { sent++ }, holdings: async () => ({ ownership: 'verified' as const, balance: '1' }),
  }
  const create = () => new DeliveryService(chain, stores[0], stores[1], stores[2], stores[3], stores[4], stores[5], undefined, () => now)
  const delivery = create(), f = await fixture({ deliver: (user, input) => delivery.enqueue(user, input) })
  const reply = await f.service.autonomousPurchase('alice', f.discovery.id, f.candidate.id, f.owner, true)
  assert.equal(reply.phase, 'DELIVERY_PENDING'); assert.equal(reply.deliveryMode, 'DEVNET_DEMO_MINT')
  assert.equal(reply.phantomSignatureRequired, false); assert.equal(prepared, 0)
  const plan = (await create().getPlan('alice', reply.id))!
  assert.equal(plan.recipientWallet, f.owner); assert.equal(plan.name, f.candidate.name)
  assert.equal(plan.sourceMint, f.candidate.mint); assert.equal(plan.rawQuantity, '1'); assert.equal(plan.decimals, 0)
  assert.ok((await f.orders.get('alice', reply.id))?.demoAcceptedAt)
  const { metadataId: _, ...input } = plan
  await create().deliver('alice', input)
  confirmed = true; now += 3600000
  assert.equal((await create().deliver('alice', input)).phase, 'COMPLETED')
  assert.equal((await f.service.autonomousPurchase('alice', reply.id, f.candidate.id, f.owner)).phase, 'COMPLETED')
  assert.equal(prepared, 1); assert.equal(sent, 1); assert.equal(f.spendCalls(), 1)
})

test('PURCHASE 1 SOL mandate -> 0.04 SOL real spend builder -> agent signature -> confirmed receipt; no Phantom', async () => {
  const f = await fixture()
  let phantomCalls = 0
  const phantom = { signTransaction() { phantomCalls++; throw new Error('Must not use Phantom') } }
  const before = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { phantom: { solana: phantom }, solana: phantom } })
  try {
    const reply = await executeAutonomousPurchase(async (path, body) => {
      assert.equal(path, '/autonomous-spend')
      return f.service.autonomousPurchase('alice', String(body!.discoveryId), String(body!.candidateId), String(body!.owner), body!.demoAccepted === true)
    }, f.discovery, f.candidate, f.owner, true)
    assert.equal(reply.result.status, 'CONFIRMED')
    assert.equal(reply.phase, 'COMPLETED')
    assert.equal(reply.delivery?.owner, f.owner)
    assert.equal(reply.delivery?.mint, f.candidate.mint)
    assert.equal(reply.execution, 'Devnet autonomous spend demo')
    assert.equal(reply.actualSpendLamports, '40000000')
    assert.equal(reply.result.spend?.spentBeforeLamports, '0')
    assert.equal(reply.result.spend?.spentAfterLamports, '40000000')
    assert.equal(reply.result.mandate?.remainingLamports, '960000000')
    assert.equal(reply.phantomSignatureRequired, false)
    assert.equal(phantomCalls, 0)
    assert.equal(f.spendCalls(), 1)
    await f.service.autonomousPurchase('alice', f.discovery.id, f.candidate.id, f.owner, true)
    assert.equal(f.sends(), 1, 'Replay must not spend twice')
    await assert.rejects(f.service.autonomous.status('bob', f.discovery.id))
  } finally {
    if (before) Object.defineProperty(globalThis, 'window', before)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})

test('new demo orders bind the verified purchaser before payment; legacy orders never silently convert', async () => {
  const f = await fixture()
  await f.service.autonomousPurchase('alice', f.discovery.id, f.candidate.id, f.owner, true)
  const order = (await f.orders.get('alice', f.discovery.id))!
  assert.equal(order.recipientWallet, f.owner)
  assert.equal(order.deliveryMode, 'DEVNET_DEMO_MINT')
  assert.equal(order.assetStandard, 'METAPLEX_CORE')
  assert.equal(order.imageUri, 'https://demo.gobuy.example/demo.png')
  assert.match(order.metadataUri!, /^https:\/\/demo\.gobuy\.example\/api\/acquisition\/delivery-metadata\/[a-f0-9]{64}$/)
  assert.ok(order.recipientVerifiedAt)
  delete order.recipientWallet; delete order.recipientVerifiedAt; delete order.deliveryMode
  await f.orders.put('alice', f.discovery.id, order)
  const before = f.spendCalls()
  const reply = await f.service.reconcilePurchase('alice', f.discovery.id, f.owner)
  assert.equal(reply.status, 'PENDING')
  assert.match(reply.message, /đồng ý nhận NFT demo/)
  assert.equal(f.spendCalls(), before)
})

test('paid NFT delivery failure stays pending and reconciliation completes without charging again', async () => {
  const f = await fixture(); f.setDeliveryPhase('DELIVERY_FAILED')
  const failed = await f.service.autonomousPurchase('alice', f.discovery.id, f.candidate.id, f.owner, true)
  assert.equal(failed.phase, 'DELIVERY_FAILED'); assert.equal(failed.result.status, 'PENDING')
  assert.equal(f.spendCalls(), 1)
  f.setDeliveryPhase('COMPLETED')
  const retry = await f.service.reconcilePurchase('alice', f.discovery.id, f.owner)
  assert.equal(retry.purchase?.phase, 'COMPLETED'); assert.equal(retry.status, 'CONFIRMED')
  assert.equal(f.spendCalls(), 1); assert.equal(f.sends(), 1)
})

test('SEARCH only discovers and is refused by both frontend and backend spend entry points', async () => {
  const f = await fixture()
  const discovery = await f.service.discover('alice', 'Find any NFT under 1 SOL')
  assert.equal(discovery.intent.action, 'SEARCH')
  await assert.rejects(f.service.autonomousPurchase('alice', discovery.id, discovery.candidates[0].id, f.owner), /SEARCH/)
  await assert.rejects(executeAutonomousPurchase(async () => { throw new Error('must not call API') }, discovery, f.candidate, f.owner), /SEARCH/)
  assert.equal(f.spendCalls(), 0)
})

test('inactive, expired, closed, category, budget, executor, vault, owner and network block before autonomousSpend', async () => {
  for (const kind of ['inactive', 'expired', 'closed', 'category', 'budget', 'executor', 'vault', 'owner', 'network', 'missing'] as const) {
    const f = await fixture()
    if (kind === 'inactive') f.mandate.active = false
    if (kind === 'expired') f.mandate.expiresAt = 1
    if (kind === 'closed') f.mandate.closed = true
    if (kind === 'category') f.mandate.allowedCategory = 'RWA'
    if (kind === 'budget') f.mandate.spentLamports = 990_000_000n
    if (kind === 'executor') f.mandate.executor = key()
    if (kind === 'vault') f.mandate.vault = key()
    if (kind === 'owner') f.mandate.owner = key()
    if (kind === 'network') f.client.connection.getGenesisHash = async () => 'mainnet'
    if (kind === 'missing') f.client.read = async () => undefined
    await assert.rejects(f.service.autonomousPurchase('alice', f.discovery.id, f.candidate.id, f.owner, true))
    assert.equal(f.spendCalls(), 0, kind)
    assert.equal(f.sends(), 0, kind)
  }
})

test('critical listing fields stay strict and listing identity cannot change during refresh', async () => {
  for (const kind of ['mint', 'seller', 'listingId', 'price', 'currency', 'network', 'identity-change'] as const) {
    const f = await fixture(), broken = structuredClone(f.candidate)
    if (kind === 'mint') broken.mint = null
    if (kind === 'seller') broken.listing.seller = null
    if (kind === 'listingId') Reflect.deleteProperty(broken.marketplaceListing!, 'listingId')
    if (kind === 'price') broken.listing.priceLamports = '0'
    if (kind === 'currency') Reflect.set(broken.listing, 'currency', 'USDC')
    if (kind === 'network') broken.sourceNetwork = 'mainnet'
    if (kind === 'identity-change') { broken.marketplaceListing!.listingId = key(); broken.asset!.owner = broken.marketplaceListing!.listingId; f.setFresh(broken) }
    else await f.discoveries.put('alice', f.discovery.id, { text: '', reply: { ...f.discovery, candidates: [broken] } })
    await assert.rejects(f.service.autonomousPurchase('alice', f.discovery.id, broken.id, f.owner, true))
    assert.equal(f.spendCalls(), 0, kind)
  }
})

test('explicit purchase language is separate from recommendations and numbered NFTs match exactly', async () => {
  const parser = new NFTIntentParser()
  for (const text of ['Find any NFT under 1 SOL', 'Recommend an NFT under 1 SOL', 'Show me NFTs under 1 SOL', 'Tìm NFT dưới 1 SOL']) {
    assert.equal((await parser.parse(text)).action, 'SEARCH', text)
  }
  for (const text of ['Buy any NFT under 1 SOL', 'Find and buy an NFT under 1 SOL', 'Na tự chọn và mua NFT dưới 1 SOL']) {
    assert.equal((await parser.parse(text)).action, 'BUY', text)
  }
  const intent = await parser.parse('Buy Bodega Monke #5 max 1 SOL')
  assert.equal(intent.action, 'BUY'); assert.equal(intent.exactNFTName, 'Bodega Monke #5')
  assert.equal(evaluateCandidates([{ ...candidate(), name: 'Bodega Monke #6' }], intent).length, 0)
  assert.equal(evaluateCandidates([candidate()], intent).length, 1)
})

test('unknown execution outcome is reconciled read-only and never resubmitted', async () => {
  const f = await fixture()
  f.client.confirm = async () => { throw new Error('RPC timeout') }
  const pending = await f.service.autonomousPurchase('alice', f.discovery.id, f.candidate.id, f.owner, true)
  assert.equal(pending.result.status, 'PENDING')
  const confirmed = await f.service.autonomous.status('alice', f.discovery.id)
  assert.equal(confirmed.result.status, 'CONFIRMED')
  assert.equal(confirmed.result.mandate?.remainingLamports, '960000000')
  assert.equal(f.sends(), 1)
})

test('named BUY uses the authenticated owner mandate ceiling and preserves exact NFT identity', async () => {
  const f = await fixture()
  const discovery = await f.service.discover('alice', 'Buy Bodega Monke #5', randomUUID(), undefined, f.owner)
  assert.equal(discovery.intent.action, 'BUY')
  assert.equal(discovery.intent.maximumLamports, '1000000000')
  assert.equal(discovery.intent.priceDiscoveryOnly, undefined)
  assert.equal(discovery.candidates[0].name, 'Bodega Monke #5')
  assert.equal(f.spendCalls(), 0, 'Discovery still never spends')
  await assert.rejects(f.service.discover('bob', 'Buy Bodega Monke #5', randomUUID(), undefined, f.owner), /xác minh/)
  await assert.rejects(f.service.autonomousPurchase('bob', f.discovery.id, f.candidate.id, f.owner, true), /xác minh/)
  assert.equal(f.spendCalls(), 0)
})

test('Anchor preflight failure is terminal, exposes exact code and does not trigger another signer', async () => {
  const f = await fixture()
  f.client.broadcast = async () => { throw new SendTransactionError({ action: 'simulate', signature: '',
    transactionMessage: 'Error processing Instruction 0: custom program error: 0x1772',
    logs: ['Program log: AnchorError. Error Code: BudgetExceeded. Error Number: 6002. Error Message: Budget exceeded.'] }) }
  const reply = await f.service.autonomousPurchase('alice', f.discovery.id, f.candidate.id, f.owner, true)
  assert.equal(reply.result.status, 'FAILED')
  assert.equal(reply.result.rejection, 'BudgetExceeded')
  assert.match(reply.result.message, /Error Code: BudgetExceeded/)
  assert.equal(reply.actualSpendLamports, null)
  await f.service.autonomousPurchase('alice', f.discovery.id, f.candidate.id, f.owner, true)
  assert.equal(f.spendCalls(), 1)
})
