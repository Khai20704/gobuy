import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Keypair, Transaction, ComputeBudgetProgram } from '@solana/web3.js'
import { DEVNET_GENESIS } from '@gobuy/shared'
import { NftPurchaseAuthorizationClient } from '../src/services/nft-purchase/NftPurchaseAuthorizationClient.js'
import type { MandateProgramClient } from '../src/services/mandate/MandateProgramClient.js'

function fixture() {
  const owner = Keypair.generate(), agent = Keypair.generate(), programId = Keypair.generate().publicKey
  let broadcasts = 0
  const client = { programId, agent, read: async () => ({ active: true, closed: false, expiresAt: Math.floor(Date.now() / 1000) + 3600,
    maxBudgetLamports: 500_000_000n, spentLamports: 0n }), connection: { rpcEndpoint: 'https://api.devnet.solana.com',
    getGenesisHash: async () => DEVNET_GENESIS,
    getLatestBlockhash: async () => ({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 123 }),
    getSignatureStatuses: async () => ({ value: [{ err: null, confirmationStatus: 'finalized' }] }) },
    broadcast: async () => { broadcasts++; return 'signature' } } as unknown as MandateProgramClient
  const service = new NftPurchaseAuthorizationClient(() => client)
  const input = { maxTotalDebitSol: 0.1, expiresInHours: 1 }
  return { owner, service, input, client, broadcasts: () => broadcasts }
}

test('authorization build/sign/submit round-trip accepts actual route fields and finalized signature', async () => {
  const f = fixture()
  const routeInput = { ...f.input, owner: f.owner.publicKey.toBase58(), transaction: 'ignored' }
  const built = await f.service.build(routeInput.owner, routeInput)
  const tx = Transaction.from(Buffer.from(built.transaction, 'base64')); tx.sign(f.owner)
  const result = await f.service.submit(routeInput.owner, routeInput, tx.serialize().toString('base64'))
  assert.equal(result.status, 'CONFIRMED'); assert.equal(f.broadcasts(), 1)
})

for (const [name, mutate] of Object.entries<(tx: Transaction) => void>({
  marketplace: tx => { tx.instructions[0].data[24] ^= 1 },
  executor: tx => { tx.instructions[0].data[56] ^= 1 },
  recipient: tx => { tx.instructions[0].data[88] ^= 1 },
  discriminator: tx => { tx.instructions[0].data[0] ^= 1 },
  budget: tx => { tx.instructions[0].data.writeBigUInt64LE(1n, 8) },
  expired: tx => { tx.instructions[0].data.writeBigInt64LE(1n, 16) },
  extendedExpiry: tx => { tx.instructions[0].data.writeBigInt64LE(BigInt(Math.floor(Date.now() / 1000) + 99999), 16) },
  account: tx => { tx.instructions[0].keys[1].pubkey = Keypair.generate().publicKey },
  extraInstruction: tx => { tx.add(tx.instructions[0]) },
  fee: tx => { tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 999999999 })) },
  truncated: tx => { tx.instructions[0].data = tx.instructions[0].data.subarray(0, 119) },
})) test('authorization refuses signed tampering: ' + name, async () => {
  const f = fixture(), owner = f.owner.publicKey.toBase58()
  const built = await f.service.build(owner, f.input)
  const tx = Transaction.from(Buffer.from(built.transaction, 'base64')); mutate(tx); tx.sign(f.owner)
  await assert.rejects(f.service.submit(owner, f.input, tx.serialize().toString('base64')))
  assert.equal(f.broadcasts(), 0)
})

test('authorization refuses invalid signature and preserves pending on transport ambiguity', async () => {
  const f = fixture(), owner = f.owner.publicKey.toBase58()
  const built = await f.service.build(owner, f.input)
  const tx = Transaction.from(Buffer.from(built.transaction, 'base64')); tx.sign(f.owner)
  const bad = tx.serialize(); bad[2] ^= 1
  await assert.rejects(f.service.submit(owner, f.input, bad.toString('base64')))
  assert.equal(f.broadcasts(), 0)
  f.client.broadcast = async () => { throw new Error('socket timeout') }
  const result = await f.service.submit(owner, f.input, tx.serialize().toString('base64'))
  assert.equal(result.status, 'PENDING'); assert.ok(result.signature)
})

test('builder pins valid compute settings and wallet fee mutation remains rejected before broadcast', async () => {
  const f = fixture(), owner = f.owner.publicKey.toBase58()
  const built = await f.service.build(owner, f.input)
  const tx = Transaction.from(Buffer.from(built.transaction, 'base64'))
  const compute = tx.instructions.filter(ix => ix.programId.equals(ComputeBudgetProgram.programId))
  assert.equal(compute.length, 2)
  assert.equal(compute[0].data.readUInt32LE(1), 200_000)
  assert.equal(compute[1].data.readBigUInt64LE(1), 10_000n)
  compute[1].data.writeBigUInt64LE(10_001n, 1); tx.sign(f.owner)
  await assert.rejects(f.service.submit(owner, f.input, tx.serialize().toString('base64')), /Compute budget/)
  assert.equal(f.broadcasts(), 0)
})

for (const units of [0, 1_400_001]) test('compute limit rejects ' + units, async () => {
  const f = fixture(), owner = f.owner.publicKey.toBase58()
  const built = await f.service.build(owner, f.input)
  const tx = Transaction.from(Buffer.from(built.transaction, 'base64'))
  tx.instructions[1] = ComputeBudgetProgram.setComputeUnitLimit({ units }); tx.sign(f.owner)
  await assert.rejects(f.service.submit(owner, f.input, tx.serialize().toString('base64')), /Compute budget/)
  assert.equal(f.broadcasts(), 0)
})
