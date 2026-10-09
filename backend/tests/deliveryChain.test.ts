import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Connection, Keypair, Transaction } from '@solana/web3.js'
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, decodeMintToCheckedInstruction, getAssociatedTokenAddressSync, MintLayout, AccountLayout } from '@solana/spl-token'
import { DEVNET_GENESIS, solanaConfig } from '@gobuy/shared'
import { SolanaDeliveryChain } from '../src/services/delivery/SolanaDeliveryChain.js'
import type { DeliveryPlan } from '../src/services/delivery/DeliveryService.js'

function fixture() {
  process.env.NFT_DEMO_PUBLIC_URL = 'https://demo.gobuy.example'
  const agent = Keypair.generate(), owner = Keypair.generate().publicKey.toBase58()
  const rpc = new Connection(solanaConfig(process.env).rpcUrl)
  rpc.getGenesisHash = async () => DEVNET_GENESIS
  rpc.getLatestBlockhash = async () => ({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 100 })
  rpc.getMinimumBalanceForRentExemption = async () => 2000000
  rpc.getAccountInfo = async () => null
  const plan: DeliveryPlan = { id: 'purchase', metadataId: 'a'.repeat(64), owner, kind: 'RWA', mode: 'RWA_TOKEN', name: 'NVIDIA xStock',
    sourceMint: 'ethereum:0xoriginal', rawQuantity: '666666', decimals: 6, paymentSignature: 'payment', image: 'https://demo.gobuy.example/nft.png' }
  return { rpc, plan, chain: new SolanaDeliveryChain(rpc, () => agent, async () => {}) }
}
test('RWA delivery transaction creates ATA, issues exact quantity, labels metadata and revokes mint authority atomically', async () => {
  const f = fixture(), attempt = await f.chain.prepare(f.plan)
  const transaction = Transaction.from(Buffer.from(attempt.wire, 'base64'))
  assert.equal(transaction.verifySignatures(), true)
  assert.ok(transaction.serialize().length <= 1232)
  assert.ok(transaction.instructions.some(ix => ix.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)))
  const issue = transaction.instructions.find(ix => ix.programId.equals(TOKEN_2022_PROGRAM_ID) && ix.data[0] === 14)!
  assert.equal(decodeMintToCheckedInstruction(issue, TOKEN_2022_PROGRAM_ID).data.amount, 666666n)
  assert.ok(transaction.instructions.some(ix => ix.data.includes(Buffer.from('DEMO RWA'))))
  assert.equal(transaction.instructions.at(-1)?.data[0], 6) // SetAuthority
  assert.equal((await f.chain.prepare(f.plan)).mint, attempt.mint)
})

test('demo NFT builds exactly one token for the bound Phantom ATA with metadata and revoked authority', async () => {
  const f = fixture()
  const plan: DeliveryPlan = { ...f.plan, kind: 'NFT', mode: 'DEVNET_DEMO_MINT', rawQuantity: '1', decimals: 0,
    recipientWallet: f.plan.owner, recipientVerifiedAt: new Date().toISOString() }
  const attempt = await f.chain.prepare(plan), tx = Transaction.from(Buffer.from(attempt.wire, 'base64'))
  const mint = new (await import('@solana/web3.js')).PublicKey(attempt.mint)
  const owner = new (await import('@solana/web3.js')).PublicKey(plan.owner)
  const instruction = tx.instructions.find(ix => ix.programId.equals(TOKEN_2022_PROGRAM_ID) && ix.data[0] === 14)!
  const mintTo = decodeMintToCheckedInstruction(instruction, TOKEN_2022_PROGRAM_ID)
  assert.equal(mintTo.data.amount, 1n); assert.equal(mintTo.data.decimals, 0)
  assert.equal(mintTo.keys.destination.pubkey.toBase58(), getAssociatedTokenAddressSync(mint, owner, false, TOKEN_2022_PROGRAM_ID).toBase58())
  assert.equal(tx.instructions.at(-1)?.data[0], 6)
  assert.ok(tx.instructions.some(ix => ix.data.includes(Buffer.from('GoBuy Demo'))))
  assert.equal((await f.chain.prepare(plan)).mint, attempt.mint)
  await assert.rejects(f.chain.prepare({ ...plan, recipientWallet: Keypair.generate().publicKey.toBase58() }), /recipient/)
  await assert.rejects(f.chain.prepare({ ...plan, recipientWallet: undefined }), /recipient/)
  await assert.rejects(f.chain.send(attempt), /LIVE_DEVNET_DELIVERY_DISABLED/)
})

test('demo ownership checks ATA owner, exact supply, decimals and revoked mint authority', async () => {
  const f = fixture(), plan: DeliveryPlan = { ...f.plan, mode: 'DEVNET_DEMO_MINT', kind: 'NFT', decimals: 0, rawQuantity: '1',
    recipientWallet: f.plan.owner, recipientVerifiedAt: new Date().toISOString() }
  const attempt = await f.chain.prepare(plan)
  const { PublicKey } = await import('@solana/web3.js')
  const mint = new PublicKey(attempt.mint), owner = new PublicKey(plan.owner), zero = PublicKey.default
  const mintData = Buffer.alloc(MintLayout.span), accountData = Buffer.alloc(AccountLayout.span)
  const encode = (supply = 1n, authority: 0 | 1 = 0, recipient = owner) => {
    MintLayout.encode({ mintAuthorityOption: authority, mintAuthority: owner, supply, decimals: 0, isInitialized: true,
      freezeAuthorityOption: 0, freezeAuthority: zero }, mintData)
    AccountLayout.encode({ mint, owner: recipient, amount: 1n, delegateOption: 0, delegate: zero, state: 1,
      isNativeOption: 0, isNative: 0n, delegatedAmount: 0n, closeAuthorityOption: 0, closeAuthority: zero }, accountData)
  }
  f.rpc.getMultipleAccountsInfo = async () => [mintData, accountData].map(data => ({ data, owner: TOKEN_2022_PROGRAM_ID, lamports: 1, executable: false }))
  encode(); assert.equal((await f.chain.holdings(plan, attempt)).ownership, 'verified')
  encode(2n); assert.equal((await f.chain.holdings(plan, attempt)).ownership, 'not_owned')
  encode(1n, 1); assert.equal((await f.chain.holdings(plan, attempt)).ownership, 'not_owned')
  encode(1n, 0, Keypair.generate().publicKey); assert.equal((await f.chain.holdings(plan, attempt)).ownership, 'not_owned')
})
test('delivery refuses a non-Devnet genesis before building or sending', async () => {
  const f = fixture(); f.rpc.getGenesisHash = async () => 'mainnet'
  await assert.rejects(f.chain.prepare(f.plan), /Only Solana Devnet/)
})

test('missing agent mint signer blocks preparation without broadcasting', async () => {
  const f = fixture()
  const chain = new SolanaDeliveryChain(f.rpc, () => { throw new Error('Agent keypair unavailable') }, async () => {})
  await assert.rejects(chain.prepare({ ...f.plan, mode: 'DEVNET_DEMO_MINT', kind: 'NFT', rawQuantity: '1', decimals: 0,
    recipientWallet: f.plan.owner, recipientVerifiedAt: new Date().toISOString() }), /Agent keypair/)
})
test('an existing Devnet NFT is never silently replaced with a demo mint', async () => {
  const f = fixture(); f.rpc.getAccountInfo = async () => null
  await assert.rejects(f.chain.prepare({ ...f.plan, kind: 'NFT', mode: 'TRANSFER_NFT', decimals: 0, rawQuantity: '1', sourceMint: TOKEN_PROGRAM_ID.toBase58() }), /does not exist/)
})
test('a Mainnet representation builds only a labeled Core Devnet NFT for the intended owner', async () => {
  const f = fixture(), attempt = await f.chain.prepare({ ...f.plan, kind: 'NFT', mode: 'DEMO_NFT', decimals: 0, rawQuantity: '1' })
  const tx = Transaction.from(Buffer.from(attempt.wire, 'base64'))
  assert.equal(attempt.standard, 'core'); assert.equal(tx.verifySignatures(), true)
  assert.ok(tx.instructions.some(ix => ix.data.includes(Buffer.from('Devnet Demo'))))
  assert.ok(tx.instructions.some(ix => ix.keys.some(key => key.pubkey.toBase58() === f.plan.owner)))
})

test('confirmed signature requires exact recipient, mint and token delta', async () => {
  const f = fixture(), attempt = await f.chain.prepare(f.plan)
  f.rpc.getSignatureStatuses = async () => ({ context: { slot: 10 }, value: [{ slot: 10, confirmations: 1, err: null, confirmationStatus: 'confirmed' }] })
  let recipient = Keypair.generate().publicKey.toBase58()
  f.rpc.getTransaction = async () => ({ meta: { err: null, preTokenBalances: [], postTokenBalances: [
    { accountIndex: 1, mint: attempt.mint, owner: recipient, uiTokenAmount: { amount: f.plan.rawQuantity, decimals: 6 } },
  ] } }) as any
  assert.equal(await f.chain.inspect(f.plan, attempt), 'uncertain')
  recipient = f.plan.owner
  assert.equal(await f.chain.inspect(f.plan, attempt), 'confirmed')
})

test('expired transaction is replaceable only after history and finalized creation marker checks', async () => {
  const f = fixture(), attempt = await f.chain.prepare(f.plan)
  f.rpc.getSignatureStatuses = async () => ({ context: { slot: 10 }, value: [null] })
  f.rpc.getBlockHeight = async () => 101
  f.rpc.getSlot = async () => 200
  f.rpc.getTransaction = async () => null
  assert.equal(await f.chain.inspect(f.plan, attempt), 'retryable')
  f.rpc.getAccountInfo = async () => ({ data: Buffer.alloc(0), executable: false, lamports: 1, owner: TOKEN_PROGRAM_ID })
  assert.equal(await f.chain.inspect(f.plan, attempt), 'uncertain')
  f.rpc.getAccountInfo = async () => { throw new Error('429') }
  await assert.rejects(f.chain.inspect(f.plan, attempt), /429/)
})

 test('Core uses an asset account, deterministic identity and exact owner/metadata without ATA', async () => {
  const { Key, MPL_CORE_PROGRAM_ID } = await import('@metaplex-foundation/mpl-core')
  const { getAssetV1AccountDataSerializer } = await import('@metaplex-foundation/mpl-core/dist/src/generated/types/assetV1AccountData.js')
  const { publicKey } = await import('@metaplex-foundation/umi')
  const { PublicKey } = await import('@solana/web3.js')
  const f = fixture(), plan: DeliveryPlan = { ...f.plan, kind: 'NFT', mode: 'DEVNET_DEMO_MINT', assetStandard: 'METAPLEX_CORE',
    decimals: 0, rawQuantity: '1', recipientWallet: f.plan.owner, recipientVerifiedAt: new Date().toISOString(),
    metadataUri: 'https://demo.gobuy.example/metadata.json', imageUri: 'https://demo.gobuy.example/demo.png' }
  const attempt = await f.chain.prepare(plan), tx = Transaction.from(Buffer.from(attempt.wire, 'base64'))
  assert.equal(attempt.standard, 'core'); assert.equal(tx.verifySignatures(), true)
  assert.equal((await f.chain.prepare(plan)).mint, attempt.mint)
  assert.ok(tx.instructions.some(ix => ix.programId.toBase58() === MPL_CORE_PROGRAM_ID))
  assert.ok(!tx.instructions.some(ix => ix.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)))
  f.rpc.getMultipleAccountsInfo = async () => { throw new Error('SPL ATA lookup forbidden') }
  const setAsset = (owner = plan.owner, uri = plan.metadataUri!) => {
    const data = Buffer.from(getAssetV1AccountDataSerializer().serialize({ key: Key.AssetV1, owner: publicKey(owner),
      updateAuthority: { __kind: 'Address', fields: [publicKey(plan.owner)] }, name: 'GoBuy Devnet Demo \u00b7 ' + plan.name, uri, seq: null }))
    f.rpc.getAccountInfo = async () => ({ data, owner: new PublicKey(MPL_CORE_PROGRAM_ID), lamports: 1, executable: false })
  }
  setAsset(); assert.equal((await f.chain.holdings(plan, attempt)).ownership, 'verified')
  setAsset(Keypair.generate().publicKey.toBase58()); assert.equal((await f.chain.holdings(plan, attempt)).ownership, 'not_owned')
  setAsset(plan.owner, 'https://wrong.example/asset'); assert.equal((await f.chain.holdings(plan, attempt)).ownership, 'not_owned')
  await assert.rejects(f.chain.prepare(plan), /Existing delivery/)
  f.rpc.getAccountInfo = async () => { throw new Error('429') }
  await assert.rejects(f.chain.holdings(plan, attempt), /429/)
 })

