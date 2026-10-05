import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Connection, Keypair, SystemInstruction, Transaction } from '@solana/web3.js'
import { DEVNET_GENESIS } from '@gobuy/shared'
import { resolveDemoBuy } from '../src/services/nftDemo/budget.js'
import { parseDemoBuy, selectDemoArt } from '../src/services/nftDemo/catalog.js'
import { NftDemoService } from '../src/services/nftDemo/NftDemoService.js'
import { MockNFTProvider } from '../src/services/acquisition/MockNFTProvider.js'

const rates = { async getRates() { return [{ base: 'SOL' as const, quoteCurrency: 'USD', rate: 100,
  observedAt: new Date().toISOString(), fetchedAt: new Date().toISOString(), sourceUrl: 'https://example.com/rate' }] } }

test('conversational Vietnamese purchase requests retain their subject and budget', async () => {
  const shoes = parseDemoBuy('tui cần mua bức tranh nft về giày dưới 1 SOL')
  assert.ok('maximumLamports' in shoes)
  assert.equal(shoes.maximumLamports, 999999999)
  assert.equal(shoes.topic, 'giay')
  assert.equal(selectDemoArt(shoes.maximumLamports, shoes.topic), undefined)
  for (const prompt of ['Tôi muốn mua tranh NFT về biển dưới 1 SOL', 'Na, mình cần mua NFT về biển dưới 1 SOL', 'I want to buy NFT of sea under 1 SOL']) {
    const result = parseDemoBuy(prompt)
    assert.ok('maximumLamports' in result)
    assert.equal(selectDemoArt(result.maximumLamports, result.topic)?.id, 'blue-tide')
  }
  for (const prompt of ['Tui không mua NFT dưới 1 SOL', 'Nếu tui mua NFT dưới 1 SOL', 'Mua NFT dưới 1 SOL được không?', 'I do not want to buy NFT under 1 SOL']) {
    assert.ok('message' in parseDemoBuy(prompt))
  }
  const service = new NftDemoService(await mkdtemp(join(tmpdir(), 'gobuy-subject-')))
  const reply = await service.prepare(crypto.randomUUID(), 'tui cần mua bức tranh nft về giày dưới 1 SOL', '')
  assert.equal(reply.status, 'NO_MATCH')
  assert.match(reply.message, /chủ đề/)
})
test('Vietnamese SOL/USD budgets preserve strict limits and do not substitute subjects', async () => {
  for (const text of ['Mua tranh NFT dưới 5 đô', 'Buy NFT under $5', 'Mua tranh NFT dưới 5 USD', 'Mua tranh NFT dưới 5 đô la']) {
    const result = await resolveDemoBuy(text, rates)
    assert.ok('maximumLamports' in result, JSON.stringify(result))
    assert.equal(result.maximumLamports, 49999999)
    assert.equal(selectDemoArt(result.maximumLamports), undefined)
  }
  const sea = parseDemoBuy('Mua tranh NFT về biển dưới 0,5 SOL')
  assert.ok('maximumLamports' in sea)
  assert.equal(sea.maximumLamports, 499999999)
  assert.equal(selectDemoArt(sea.maximumLamports, sea.topic)?.id, 'blue-tide')
  const forest = parseDemoBuy('Mua tranh NFT về rừng dưới 1 SOL')
  assert.ok('maximumLamports' in forest)
  assert.equal(selectDemoArt(forest.maximumLamports, forest.topic)?.id, 'forest-canopy')
  for (const text of ['Không mua NFT dưới 1 SOL', 'Mua 2 tranh NFT dưới 1 SOL', 'Mua NFT dưới 0 SOL', 'Mua NFT dưới 5 USD và dưới 1 SOL']) {
    assert.ok('message' in await resolveDemoBuy(text, rates))
  }
  assert.ok('message' in await resolveDemoBuy('Mua NFT dưới 5 đô', { async getRates() { throw new Error('offline') } }))
  assert.ok('message' in await resolveDemoBuy('Mua NFT dưới 5 đô', { async getRates() { return (await rates.getRates()).map(r => ({ ...r, observedAt: '2000-01-01T00:00:00Z' })) } }))
})

test('preparation spends nothing; signed payment matches price; tampering/replay cannot send again', async () => {
  const owner = Keypair.generate()
  let usdRate = 100
  const service = new NftDemoService(await mkdtemp(join(tmpdir(), 'gobuy-unit-')), undefined, undefined,
    { async getRates() { return (await rates.getRates()).map(rate => ({ ...rate, rate: usdRate })) } })
  const connection = (service as unknown as { connection: Connection }).connection
  connection.getGenesisHash = async () => DEVNET_GENESIS
  connection.getBalance = async () => 5e9
  connection.getLatestBlockhash = async () => ({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 200 })
  connection.getFeeForMessage = async () => ({ context: { slot: 1 }, value: 10000 })
  connection.simulateTransaction = (async () => ({ context: { slot: 1 }, value: {
    err: null, logs: [], accounts: [{ lamports: 5e9 - 205000000, executable: false, owner: owner.publicKey.toBase58(), data: [] }],
  } })) as typeof connection.simulateTransaction
  let sends = 0
  connection.sendRawTransaction = async wire => {
    sends++
    assert.equal(Transaction.from(wire).verifySignatures(), true)
    return 'test-signature'
  }
  service.status = async () => ({ status: 'CONFIRMED', signature: 'test-signature', totalLamports: 205010000, message: 'Mock confirmation' })
  const id = crypto.randomUUID()
  connection.getBalance = async () => 1
  await assert.rejects(service.prepare(crypto.randomUUID(), 'Mua NFT dưới 1 SOL', owner.publicKey.toBase58()), /Cần khoảng/)
  connection.getBalance = async () => 5e9
  const result = await service.prepare(id, 'Mua tranh NFT về biển dưới 0.5 SOL', owner.publicKey.toBase58())
  assert.equal(result.status, 'READY', result.message)
  assert.equal(sends, 0)
  const transaction = Transaction.from(Buffer.from(result.quote.transaction, 'base64'))
  await assert.rejects(service.submit(id, result.quote.transaction), /Chữ ký/)
  assert.equal(sends, 0, 'Missing buyer approval must never submit')
  const transfer = SystemInstruction.decodeTransfer(transaction.instructions.at(-1)!)
  assert.equal(transfer.fromPubkey.toBase58(), owner.publicKey.toBase58())
  assert.equal(transfer.lamports, 200000000n)
  assert.equal(transaction.instructions.length, 2, 'NFT creation and payment must be atomic')
  const tampered = Transaction.from(Buffer.from(result.quote.transaction, 'base64'))
  tampered.instructions.pop()
  tampered.signatures = []
  tampered.partialSign(owner)
  await assert.rejects(service.submit(id, tampered.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64')))
  assert.equal(sends, 0)
  transaction.partialSign(owner)
  const wire = transaction.serialize().toString('base64')
  await service.submit(id, wire)
  await service.submit(id, wire)
  assert.equal(sends, 1)
  const uncertainId = crypto.randomUUID()
  const uncertain = await service.prepare(uncertainId, 'Mua tranh NFT về biển dưới 0.5 SOL', owner.publicKey.toBase58())
  if (uncertain.status !== 'READY') throw new Error(uncertain.message)
  const uncertainTx = Transaction.from(Buffer.from(uncertain.quote.transaction, 'base64'))
  uncertainTx.partialSign(owner)
  connection.sendRawTransaction = async () => { sends++; throw new Error('Connection lost after send') }
  service.status = async () => ({ status: 'PENDING', message: 'No receipt yet' })
  const uncertainWire = uncertainTx.serialize().toString('base64')
  assert.equal((await service.submit(uncertainId, uncertainWire)).status, 'PENDING')
  await service.submit(uncertainId, uncertainWire)
  assert.equal(sends, 2, 'Unknown result must not trigger a second send')
  const usdId = crypto.randomUUID()
  const usd = await service.prepare(usdId, 'Mua tranh NFT về biển dưới 50 đô', owner.publicKey.toBase58())
  if (usd.status !== 'READY') throw new Error(usd.message)
  const usdTx = Transaction.from(Buffer.from(usd.quote.transaction, 'base64'))
  usdTx.partialSign(owner)
  usdRate = 1000
  await assert.rejects(service.submit(usdId, usdTx.serialize().toString('base64')), /Tỷ giá USD/)
  assert.equal(sends, 2, 'A changed USD rate cannot authorize an over-budget payment')
  const privateId = crypto.randomUUID()
  const privateOrder = await service.prepare(privateId, 'Mua tranh NFT về biển dưới 0.5 SOL', owner.publicKey.toBase58(), 'account-a')
  if (privateOrder.status !== 'READY') throw new Error(privateOrder.message)
  await assert.rejects(service.prepare(privateId, 'Mua tranh NFT về biển dưới 0.5 SOL', owner.publicKey.toBase58(), 'account-b'), /another account/)
  const privateTx = Transaction.from(Buffer.from(privateOrder.quote.transaction, 'base64'))
  privateTx.partialSign(owner)
  await assert.rejects(service.submit(privateId, privateTx.serialize().toString('base64'), 'account-b'), /another account/)
  assert.equal(sends, 2)
})

test('marketplace representation quotes preserve original mint and label Devnet simulation', async () => {
  const owner = Keypair.generate(), sourceMint = Keypair.generate().publicKey.toBase58()
  const service = new NftDemoService(await mkdtemp(join(tmpdir(), 'gobuy-representation-')))
  const connection = (service as unknown as { connection: Connection }).connection
  connection.getGenesisHash = async () => DEVNET_GENESIS
  connection.getBalance = async () => 5e9
  connection.getLatestBlockhash = async () => ({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 200 })
  connection.getFeeForMessage = async () => ({ context: { slot: 1 }, value: 10000 })
  connection.simulateTransaction = (async () => ({ context: { slot: 1 }, value: { err: null, logs: [],
    accounts: [{ lamports: 5e9 - 725000000, executable: false, owner: owner.publicKey.toBase58(), data: [] }] } })) as typeof connection.simulateTransaction
  const source = { ...(await new MockNFTProvider().search({} as never))[0], id: 'real-source', sourceNetwork: 'devnet' as const,
    mint: sourceMint, name: 'External Ocean NFT', listing: { priceLamports: '720000000', currency: 'SOL' as const, seller: Keypair.generate().publicKey.toBase58(), url: 'https://example.com/nft', observedAt: new Date().toISOString() } }
  // Mainnet listings are research-only: the representation path must refuse to build any transaction for them.
  await assert.rejects(service.prepareRepresentation(crypto.randomUUID(), { ...source, sourceNetwork: 'mainnet' as const },
    999999999, owner.publicKey.toBase58(), 'alice'), /MAINNET_READ_ONLY/)
  const result = await service.prepareRepresentation(crypto.randomUUID(), source, 999999999, owner.publicKey.toBase58(), 'alice')
  assert.equal(result.status, 'READY')
  assert.equal(result.quote.simulated, true)
  assert.equal(result.quote.network, 'devnet')
  assert.equal(result.quote.sourceAsset?.mint, sourceMint)
  assert.notEqual(result.quote.asset, sourceMint)
  assert.match(result.message, /không phải tài sản gốc/)
  assert.equal(result.quote.priceLamports, 720000000)
  assert.equal(result.quote.estimatedTotalLamports, 725010000)
  assert.equal(result.quote.sourceAsset?.sourceNetwork, 'devnet')
  await assert.rejects(service.submit(result.quote.id, result.quote.transaction, 'alice'), /xác minh listing/)
})
