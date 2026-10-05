import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Keypair, Transaction, SystemProgram } from '@solana/web3.js'
import { DEVNET_GENESIS, checkMandateSpend, RENT_EXEMPT_MINIMUM_LAMPORTS, mandateSubmitResponseSchema, createMandateInputSchema } from '@gobuy/shared'
import { MandateProgramClient } from '../src/services/mandate/MandateProgramClient.js'
import { decodeMandateAccount, MANDATE_DATA_SIZE, accountDiscriminator, mandateProgramId } from '../src/services/mandate/MandateGuard.js'
import { executeVaultSpend, spendIdFor } from '../src/services/mandate/autonomousSpend.js'
import { encodeCreateMandateArgs } from '../src/services/mandate/mandateInstructions.js'
import { prependCreateMandateComputeBudget } from '../../frontend/src/services/solana/createMandateComputeBudget.js'

const owner = Keypair.generate(), agent = Keypair.generate(), recipient = Keypair.generate(), program = Keypair.generate().publicKey
const policy = { active: true, closed: false, expiresAt: 2000, allowedCategory: 'NFT' as const, maxBudgetLamports: 1000000000n, spentLamports: 0n }
function check(change = {}, amount = 200000000n, funded = 1000000000n) {
  return checkMandateSpend({ mandate: { ...policy, ...change }, category: 'NFT', amountLamports: amount, nowSeconds: 1000, vaultLamports: funded + RENT_EXEMPT_MINIMUM_LAMPORTS })
}
test('1 SOL budget spends 0.2, leaving 0.8', () => assert.deepEqual(check(), { allowed: true, spentAfter: 200000000n, remainingAfter: 800000000n }))
test('0.8 already spent plus 0.3 is rejected', () => assert.deepEqual(check({ spentLamports: 800000000n }, 300000000n), { allowed: false, rejection: 'BudgetExceeded' }))
test('expiry, inactive, category and actual funded balance reject independently', () => {
  assert.deepEqual(check({ expiresAt: 999 }), { allowed: false, rejection: 'MandateExpired' })
  assert.deepEqual(check({ active: false }), { allowed: false, rejection: 'MandateNotActive' })
  assert.deepEqual(check({ allowedCategory: 'RWA' }), { allowed: false, rejection: 'InvalidCategory' })
  assert.deepEqual(check({}, 200000000n, 100000000n), { allowed: false, rejection: 'InsufficientVaultBalance' })
  assert.equal(check({ expiresAt: 1000 }).allowed, true)
})
function fixture() {
  const client = new MandateProgramClient(program, agent, recipient.publicKey)
  client.read = async () => undefined
  client.connection.getGenesisHash = async () => DEVNET_GENESIS
  client.connection.getLatestBlockhash = async () => ({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 999 })
  let sent = 0
  client.broadcast = async () => { sent++; return '2'.repeat(88) }
  client.confirm = async (_signature, _blockhash, height) => { assert.equal(height, 999); return null }
  return { client, sent: () => sent }
}
async function built(client: MandateProgramClient) {
  const result = await client.ownerTransaction({ owner: owner.publicKey.toBase58(), action: 'create', create: { budgetSol: 1, expiresInHours: 24, category: 'NFT' } })
  const transaction = Transaction.from(Buffer.from(result.transaction, 'base64'))
  prependCreateMandateComputeBudget(transaction)
  return transaction
}
test('owner create survives serialization and retains server blockhash height', async () => {
  const f = fixture(), tx = await built(f.client)
  // Discriminator + budget + expiry + category precede the fixed backend recipient.
  assert.deepEqual(tx.instructions[2].data.subarray(25, 57), recipient.publicKey.toBuffer())
  assert.equal(tx.lastValidBlockHeight, undefined)
  tx.sign(owner)
  const result = await f.client.submitOwnerTransaction({ owner: owner.publicKey.toBase58(), action: 'create', transaction: tx.serialize().toString('base64') })
  assert.equal(mandateSubmitResponseSchema.parse(result).status, 'CONFIRMED')
  assert.equal(f.sent(), 1)
})

test('create accepts only budget, duration and category and refuses a caller-supplied recipient', () => {
  const input = { budgetSol: 1, expiresInHours: 24, category: 'NFT' }
  assert.equal(createMandateInputSchema.safeParse(input).success, true)
  assert.equal(createMandateInputSchema.safeParse({ ...input, recipient: owner.publicKey.toBase58() }).success, false)
})

test('missing backend settlement blocks creation before requesting a signing transaction', async () => {
  const client = new MandateProgramClient(program, agent, null)
  client.read = async () => undefined
  client.connection.getGenesisHash = async () => DEVNET_GENESIS
  client.connection.getLatestBlockhash = async () => { throw new Error('Must reject before building') }
  await assert.rejects(built(client), /Thanh toán demo Devnet chưa sẵn sàng/)
})
test('reject changed signed instruction, extra transfer and missing signature before broadcast', async () => {
  for (const tamper of ['amount', 'extra', 'unsigned', 'limit', 'price', 'missing-budget', 'reordered']) {
    const f = fixture(), tx = await built(f.client)
    if (tamper === 'amount') tx.instructions[2].data[8] ^= 1
    if (tamper === 'limit') tx.instructions[0].data[1] ^= 1
    if (tamper === 'price') tx.instructions[1].data[1] ^= 1
    if (tamper === 'missing-budget') tx.instructions.splice(0, 2)
    if (tamper === 'reordered') tx.instructions.reverse()
    if (tamper === 'extra') tx.add(SystemProgram.transfer({ fromPubkey: owner.publicKey, toPubkey: recipient.publicKey, lamports: 1 }))
    if (tamper !== 'unsigned') tx.sign(owner)
    await assert.rejects(f.client.submitOwnerTransaction({ owner: owner.publicKey.toBase58(), action: 'create', transaction: tx.serialize({ requireAllSignatures: false }).toString('base64') }))
    assert.equal(f.sent(), 0)
  }
})
test('wrong owner cannot submit another owner transaction', async () => {
  const f = fixture(), tx = await built(f.client)
  tx.sign(owner)
  await assert.rejects(f.client.submitOwnerTransaction({ owner: recipient.publicKey.toBase58(), action: 'create', transaction: tx.serialize().toString('base64') }))
  assert.equal(f.sent(), 0)
})
test('wrong network rejects building and broadcasting', async () => {
  const f = fixture()
  f.client.connection.getGenesisHash = async () => 'mainnet'
  await assert.rejects(built(f.client), /Devnet/)
  const client = new MandateProgramClient(program, agent, null)
  client.connection.getGenesisHash = async () => 'mainnet'
  await assert.rejects(client.broadcast(new Transaction()), /Devnet/)
})
test('confirmation timeout preserves signature and returns PENDING', async () => {
  const f = fixture(), tx = await built(f.client)
  tx.sign(owner)
  f.client.confirm = async () => { throw new Error('timeout') }
  const result = await f.client.submitOwnerTransaction({ owner: owner.publicKey.toBase58(), action: 'create', transaction: tx.serialize().toString('base64') })
  assert.equal(result.status, 'PENDING'); assert.ok(result.signature)
})
test('executor is encoded in create and decoded from Anchor state', () => {
  const args = encodeCreateMandateArgs({ maxBudgetLamports: 1n, expiresAt: 2000, category: 'NFT', recipient: recipient.publicKey, executor: agent.publicKey })
  assert.equal(args.length, 81)
  assert.deepEqual(args.subarray(49), agent.publicKey.toBuffer())
  const data = Buffer.alloc(MANDATE_DATA_SIZE)
  Buffer.from(accountDiscriminator('Mandate'), 'hex').copy(data)
  agent.publicKey.toBuffer().copy(data, 149)
  assert.equal(decodeMandateAccount(data).executor, agent.publicKey.toBase58())
  assert.equal(mandateProgramId({ NA_PROGRAM_ID: SystemProgram.programId.toBase58() }), undefined)
})
test('autonomous spend never signs with owner and enforces executor', async () => {
  const f = fixture()
  f.client.read = async () => ({ ...policy, expiresAt: Math.floor(Date.now() / 1000) + 3600, address: program.toBase58(), owner: owner.publicKey.toBase58(), executor: recipient.publicKey.toBase58(), vault: Keypair.generate().publicKey.toBase58(), recipient: recipient.publicKey.toBase58(), createdAt: 0, closedAt: 0, status: 'ACTIVE', vaultLamports: 1000890880n })
  f.client.connection.getAccountInfo = async () => null
  await assert.rejects(executeVaultSpend(f.client, { owner: owner.publicKey.toBase58(), userId: 'test', amountLamports: 1n, category: 'NFT', assetHash: 'a'.repeat(64), reference: 'demo' }), /executor/)
  assert.equal(f.sent(), 0)
  assert.equal(spendIdFor('m', 'a', 1n, 'r'), spendIdFor('m', 'a', 1n, 'r'))
})
