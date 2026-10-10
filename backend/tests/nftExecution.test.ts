import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Keypair, PublicKey, Transaction, TransactionInstruction, type ParsedTransactionWithMeta } from '@solana/web3.js'
import { getAssociatedTokenAddressSync } from '@solana/spl-token'
import { DEVNET_GENESIS, nftCandidateSchema, base58Encode, TENSOR_MARKETPLACE_PROGRAM_ID } from '@gobuy/shared'
import { FileAssetStore } from '../src/persistence/AssetStore.js'
import { NftPurchaseService, type NftPurchaseOrder } from '../src/services/nft-purchase/NftPurchaseService.js'
import { purchaseTransaction, assertPurchasePacketSize } from '../src/services/nft-purchase/purchaseTransaction.js'
import { verifyPurchaseDelivery } from '../src/services/nft-purchase/verifyPurchaseDelivery.js'
import { decodeNftPurchaseReceipt } from '../src/services/nft-purchase/nftPurchaseAccounts.js'
import { mandateAddress, mandateVaultAddress } from '../src/services/mandate/MandateGuard.js'
import type { MandateProgramClient } from '../src/services/mandate/MandateProgramClient.js'
import type { TensorBuyInstruction } from '@gobuy/tensor-adapter'

const evidence = (name: string) => JSON.parse(readFileSync(new URL('../../docs/evidence/step8/step7-pass/docs__evidence__step7__' + name + '.json', import.meta.url), 'utf8'))
const program = new PublicKey('CHjdqooB7TrussJoZoboFP5TtdCspoHtvPpqoshbr5zE')

test('actual Step 7 account shape fits packet with explicit measured compute budget', () => {
  const message = evidence('007-valid-purchase-message'), ix = message.instructions[1]
  const transaction = purchaseTransaction(new PublicKey(message.feePayer), { blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 123 },
    new TransactionInstruction({ programId: new PublicKey(ix.programId), data: Buffer.from(ix.data, 'hex'),
      keys: ix.accounts.map((a: { address: string; isSigner: boolean; isWritable: boolean }) => ({ ...a, pubkey: new PublicKey(a.address) })) }))
  assert.equal(transaction.instructions[0].data.readUInt32LE(1), 200000)
  const bytes = assertPurchasePacketSize(transaction); assert.ok(bytes <= 1232); console.log('Genuine purchase packet bytes:', bytes)
  transaction.add(new TransactionInstruction({ programId: program, keys: [], data: Buffer.alloc(1232) }))
  assert.throws(() => assertPurchasePacketSize(transaction))
})

test('finalized delivery evidence verifies actual token change; API/receipt alone and wrong owner fail', () => {
  const raw = evidence('007-valid-purchase-transaction'), state = evidence('valid-purchase-after-state')
  const receipt = decodeNftPurchaseReceipt(state.accounts.receipt.address, Buffer.from(state.accounts.receipt.value.data, 'base64'))
  const tx = { ...raw, transaction: { signatures: [raw.signature], message: {
    accountKeys: raw.transaction.message.accountKeys.map((key: string, i: number) => ({ pubkey: new PublicKey(key), signer: i === 0, writable: true })),
    instructions: raw.transaction.message.instructions.filter((ix: { programIdIndex: number }) => raw.transaction.message.accountKeys[ix.programIdIndex] === program.toBase58()).map((ix: { accounts: number[]; data: string }) => ({ programId: program, accounts: ix.accounts.map(index => new PublicKey(raw.transaction.message.accountKeys[index])), data: ix.data })), recentBlockhash: raw.transaction.message.recentBlockhash } } } as ParsedTransactionWithMeta
  assert.equal(verifyPurchaseDelivery(tx, raw.signature, program, receipt).amount, '1')
  assert.throws(() => verifyPurchaseDelivery({ ...tx, meta: null }, raw.signature, program, receipt))
  assert.throws(() => verifyPurchaseDelivery(tx, raw.signature, program, { ...receipt, owner: Keypair.generate().publicKey.toBase58() }))
  assert.throws(() => verifyPurchaseDelivery(tx, 'other-signature', program, receipt))
})

async function fixture() {
  const agent = Keypair.generate(), owner = Keypair.generate().publicKey.toBase58()
  const mint = Keypair.generate().publicKey.toBase58(), seller = Keypair.generate().publicKey.toBase58()
  const listing = Keypair.generate().publicKey.toBase58(), now = new Date().toISOString()
  const mandate = mandateAddress(program, owner), vault = mandateVaultAddress(program, mandate)
  const state = { address: mandate.toBase58(), owner, executor: agent.publicKey.toBase58(), active: true, closed: false,
    expiresAt: Math.floor(Date.now() / 1000) + 3600, allowedCategory: 'NFT', maxBudgetLamports: 500000000n, spentLamports: 0n }
  const auth = Buffer.from(evidence('valid-purchase-before-state').accounts.authorization.value.data, 'base64')
  for (const [offset, value] of [[9, mandate.toBase58()], [41, owner], [73, agent.publicKey.toBase58()], [137, owner]] as const) new PublicKey(value).toBuffer().copy(auth, offset)
  auth.writeBigInt64LE(BigInt(state.expiresAt),185)
  const candidate = nftCandidateSchema.parse({ id: 'tensor:' + mint, provider: 'tensor', sourceNetwork: 'devnet', mint,
    name: 'Offline fixture', description: '', image: null, collection: '', attributes: [],
    asset: { mint, owner: listing, network: 'devnet', verifiedAt: now },
    marketplaceListing: { listingId: listing, mint, seller, priceLamports: '100000000', currency: 'SOL', marketplace: 'Tensor', network: 'devnet', status: 'LISTED' },
    listing: { seller, priceLamports: '100000000', currency: 'SOL', observedAt: now, url: '' } })
  const accounts = Array.from({ length: 24 }, () => ({ address: TENSOR_MARKETPLACE_PROGRAM_ID, isSigner: false, isWritable: false }))
  for (const [i, address] of [[1, owner],[2,getAssociatedTokenAddressSync(new PublicKey(mint),new PublicKey(owner)).toBase58()], [4,listing], [5,mint], [6,seller],[7,vault.toBase58()]] as const) accounts[i] = { address, isSigner: i === 7, isWritable: i !== 1 && i !== 5 }
  const data = Buffer.from('447f2b08d41ff97200e1f505000000000000','hex')
  const tensor = { programAddress: TENSOR_MARKETPLACE_PROGRAM_ID, accounts, data, mint, seller, listState: listing, priceLamports: '100000000' } satisfies TensorBuyInstruction
  const orders = new FileAssetStore<NftPurchaseOrder>(await mkdtemp(join(tmpdir(),'genuine-nft-')))
  const discoveryId = randomUUID(); let broadcasts = 0, authRead = true
  const client = { programId: program, agent, read: async () => state,
    connection: { rpcEndpoint: 'https://api.devnet.solana.com', getGenesisHash: async () => DEVNET_GENESIS,
      getAccountInfo: async (_address: PublicKey, commitment: string) => commitment === 'confirmed' && authRead ? { owner: program, data: auth } : null,
      getLatestBlockhash: async () => ({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 321 }),
      getSignatureStatuses: async () => ({ value: [null] }) },
    broadcast: async (transaction: Transaction) => {
      broadcasts++
      const saved = await orders.get('user',discoveryId)
      assert.equal(saved?.signature,base58Encode(transaction.signature!)); assert.equal(saved?.lastValidBlockHeight,321)
      throw new Error('transport timeout after send')
    } } as unknown as MandateProgramClient
  const make = (live = true) => new NftPurchaseService(() => client, async () => tensor, () => live, orders)
  return { make, client, orders, request: { discoveryId, owner, candidate }, broadcasts: () => broadcasts, noAuth: () => {authRead=false} }
}

test('concurrent workers reserve once, persist signature before broadcast, restart never resubmits unknown', async () => {
  const f = await fixture()
  const results = await Promise.allSettled([f.make().purchase('user',f.request), f.make().purchase('user',f.request)])
  assert.equal(f.broadcasts(),1)
  assert.ok(results.some(result => result.status === 'fulfilled' && result.value.status === 'PENDING'))
  assert.equal((await f.make().purchase('user',f.request)).status,'PENDING')
  assert.equal((await f.make().status('user',f.request.discoveryId)).status,'PENDING')
  assert.equal(f.broadcasts(),1)
})
test('missing authorization and disabled live gate never broadcast; mainnet refused', async () => {
  const f = await fixture()
  assert.equal((await f.make(false).purchase('user',f.request)).status,'PURCHASE_DISABLED')
  f.noAuth(); assert.equal((await f.make().purchase('user',f.request)).status,'AUTHORIZATION_REQUIRED')
  await assert.rejects(f.make().purchase('user',{...f.request,candidate:{...f.request.candidate,sourceNetwork:'mainnet'}}))
  assert.equal(f.broadcasts(),0)
})

test('reconciliation requires finalized transaction delivery even when a matching receipt exists', async () => {
  const raw = evidence('007-valid-purchase-transaction'), state = evidence('valid-purchase-after-state')
  const receipt = state.decoded.receipt, discoveryId = randomUUID()
  const orders = new FileAssetStore<NftPurchaseOrder>(await mkdtemp(join(tmpdir(),'nft-reconcile-')))
  const order: NftPurchaseOrder = { discoveryId, orderId: receipt.orderId, owner: receipt.owner, mint: receipt.mint,
    listing: receipt.listing, seller: state.accounts.seller.address, priceLamports: receipt.priceLamports,
    maxTotalDebitLamports: '110000000', receiptAddress: receipt.address, status: 'SUBMITTED', signature: raw.signature,
    attempts: 1, createdAt: '', updatedAt: '', message: 'Pending' }
  await orders.put('user',discoveryId,order)
  let available = false
  const tx = { ...raw, transaction: { signatures: [raw.signature], message: {
    accountKeys: raw.transaction.message.accountKeys.map((key: string, i: number) => ({ pubkey: new PublicKey(key), signer: i === 0, writable: true })),
    instructions: raw.transaction.message.instructions.filter((ix: { programIdIndex: number }) => raw.transaction.message.accountKeys[ix.programIdIndex] === program.toBase58()).map((ix: { accounts: number[]; data: string }) => ({ programId: program, accounts: ix.accounts.map(index => new PublicKey(raw.transaction.message.accountKeys[index])), data: ix.data })), recentBlockhash: raw.transaction.message.recentBlockhash } } }
  const client = { programId: program, connection: { rpcEndpoint:'https://api.devnet.solana.com',getGenesisHash:async()=>DEVNET_GENESIS,
    getAccountInfo: async (_key: PublicKey, commitment: string) => { assert.equal(commitment,'finalized'); return {owner:program,data:Buffer.from(state.accounts.receipt.value.data,'base64')} },
    getParsedTransaction: async (_sig: string, options: {commitment:string}) => {assert.equal(options.commitment,'finalized');return available?tx:null} },
    broadcast: async () => { throw new Error('MUST NOT BROADCAST') } } as unknown as MandateProgramClient
  const service = new NftPurchaseService(()=>client, undefined,()=>false,orders)
  assert.equal((await service.status('user',discoveryId)).status,'PENDING')
  available=true
  const result=await service.status('user',discoveryId)
  assert.equal(result.status,'CONFIRMED');assert.equal(result.delivery?.owner,receipt.owner)
  available=false
  assert.equal((await service.status('user',discoveryId)).status,'PENDING')
  await orders.put('user',discoveryId,{...order,listing:Keypair.generate().publicKey.toBase58()})
  await assert.rejects(service.status('user',discoveryId),/Receipt fields/)
})
