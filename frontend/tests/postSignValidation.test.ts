import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { ComputeBudgetInstruction, ComputeBudgetProgram, Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } from '@solana/web3.js'
import { DEVNET_GENESIS } from '@gobuy/shared'
import { signDevnetTransaction } from '../src/services/solana/walletSafety.ts'
import { collectPostSignChecks, snapshotTransaction } from '../src/services/solana/postSignChecks.ts'
import type { PhantomProvider } from '../src/services/solana/phantom.ts'
import { prependCreateMandateComputeBudget } from '../src/services/solana/createMandateComputeBudget.ts'

/**
 * Reproduces the exact CreateMandate wire flow:
 *  - backend builds the create_mandate instruction and returns `serialize({ requireAllSignatures: false })`
 *  - frontend parses it back with `Transaction.from`
 *  - Phantom adds the owner signature (in place or by returning a re-parsed transaction)
 * The signed MESSAGE must stay byte-identical; only signatures are allowed to change.
 */

function discriminator(name: string) {
  return createHash('sha256').update('global:' + name).digest().subarray(0, 8)
}

// Mirrors backend `createMandateInstruction` (anchor/programs/gobuy_na layout): one real anchor-style
// instruction with several account metas and a large data payload.
function createMandateInstruction(programId: PublicKey, owner: PublicKey): TransactionInstruction {
  const [mandate] = PublicKey.findProgramAddressSync([Buffer.from('mandate'), owner.toBuffer()], programId)
  const [vault] = PublicKey.findProgramAddressSync([Buffer.from('vault'), mandate.toBuffer()], programId)
  const data = Buffer.concat([discriminator('create_mandate'), Buffer.alloc(8 + 8 + 1 + 32 + 32, 7)])
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: owner, isSigner: true, isWritable: true },
      { pubkey: mandate, isSigner: false, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  })
}

function backendUnsignedWire(programId: PublicKey, owner: PublicKey, blockhash: string): Buffer {
  return new Transaction({ feePayer: owner, blockhash, lastValidBlockHeight: 1 })
    .add(createMandateInstruction(programId, owner))
    .serialize({ requireAllSignatures: false, verifySignatures: false })
}

function devnetConnection(): Connection {
  const connection = new Connection('https://example.invalid')
  connection.getGenesisHash = async () => DEVNET_GENESIS
  connection.isBlockhashValid = async () => ({ context: { slot: 1 }, value: true })
  return connection
}

// Phantom adds a signature but never changes the message. Two provider behaviors are both valid.
function phantomWallet(owner: Keypair, mode: 'in-place' | 'copy'): PhantomProvider {
  return {
    isPhantom: true,
    publicKey: owner.publicKey,
    async signTransaction(transaction: Transaction) {
      const signed = mode === 'copy'
        ? Transaction.from(transaction.serialize({ requireAllSignatures: false, verifySignatures: false }))
        : transaction
      signed.partialSign(owner)
      return signed
    },
  } as unknown as PhantomProvider
}

test('CreateMandate simulates the exact final message, checks freshness, then signs strictly', async () => {
  const owner = Keypair.generate()
  const transaction = Transaction.from(backendUnsignedWire(Keypair.generate().publicKey, owner.publicKey, Keypair.generate().publicKey.toBase58()))
  const original = snapshotTransaction(transaction).instructions[0]
  prependCreateMandateComputeBudget(transaction)
  assert.equal(ComputeBudgetInstruction.decodeSetComputeUnitLimit(transaction.instructions[0]).units, 35_000)
  assert.equal(ComputeBudgetInstruction.decodeSetComputeUnitPrice(transaction.instructions[1]).microLamports, 0n)
  assert.deepEqual(snapshotTransaction(transaction).instructions[2], { ...original, index: 2 })
  const before = transaction.serializeMessage()
  const events: string[] = []
  const connection = devnetConnection()
  connection.isBlockhashValid = async () => { events.push('fresh'); return { context: { slot: 1 }, value: true } }
  connection.simulateTransaction = (async (copy: { message: { serialize(): Uint8Array } }, options: unknown) => {
    events.push('simulate')
    assert.deepEqual(Buffer.from(copy.message.serialize()), before)
    assert.deepEqual(options, { commitment: 'confirmed', sigVerify: false, replaceRecentBlockhash: false })
    return { context: { slot: 1 }, value: { err: null, logs: [], unitsConsumed: 14_851 } }
  }) as unknown as typeof connection.simulateTransaction
  const wallet = phantomWallet(owner, 'copy')
  const sign = wallet.signTransaction.bind(wallet)
  wallet.signTransaction = async value => { events.push('sign'); return sign(value) }
  const signed = await signDevnetTransaction(wallet, transaction, connection, undefined, true)
  assert.deepEqual(events, ['fresh', 'simulate', 'fresh', 'sign'])
  assert.deepEqual(signed.serializeMessage(), before)
  assert.ok(signed.verifySignatures())
})

test('final CreateMandate blocks simulation failure, expiry and wallet instruction mutations', async () => {
  for (const mode of ['simulation-error', 'rpc-error', 'expired', 'add', 'remove', 'price', 'limit', 'mandate'] as const) {
    const owner = Keypair.generate()
    const transaction = Transaction.from(backendUnsignedWire(Keypair.generate().publicKey, owner.publicKey, Keypair.generate().publicKey.toBase58()))
    prependCreateMandateComputeBudget(transaction)
    const connection = devnetConnection()
    let freshnessChecks = 0, signCalls = 0
    connection.isBlockhashValid = async () => ({ context: { slot: 1 }, value: mode !== 'expired' || ++freshnessChecks === 1 })
    connection.simulateTransaction = (async () => {
      if (mode === 'rpc-error') throw new Error('RPC unavailable')
      return { context: { slot: 1 }, value: { err: mode === 'simulation-error' ? 'AccountNotFound' : null, logs: [] } }
    }) as typeof connection.simulateTransaction
    const wallet = phantomWallet(owner, 'in-place')
    wallet.signTransaction = async value => {
      signCalls++
      // A NON-ComputeBudget instruction carries accounts, so it must still be rejected.
      if (mode === 'add') value.add(SystemProgram.transfer({ fromPubkey: owner.publicKey, toPubkey: owner.publicKey, lamports: 1 }))
      if (mode === 'remove') value.instructions.splice(0, 1)
      if (mode === 'price') value.instructions[1].data[1] = 1
      if (mode === 'limit') value.instructions[0].data[1] ^= 1
      if (mode === 'mandate') value.instructions[2].data[9] ^= 1
      value.partialSign(owner)
      return value
    }
    await assert.rejects(signDevnetTransaction(wallet, transaction, connection, undefined, true),
      /simulation failed|RPC unavailable|expired during simulation|Post-sign validation failed/)
    assert.equal(signCalls, ['simulation-error', 'rpc-error', 'expired'].includes(mode) ? 0 : 1)
  }
})

test('final CreateMandate accepts the ComputeBudget instructions Phantom injects while signing', async () => {
  const owner = Keypair.generate()
  const transaction = Transaction.from(backendUnsignedWire(Keypair.generate().publicKey, owner.publicKey, Keypair.generate().publicKey.toBase58()))
  prependCreateMandateComputeBudget(transaction)
  const connection = devnetConnection()
  connection.simulateTransaction = (async () => ({ context: { slot: 1 }, value: { err: null, logs: [], unitsConsumed: 14_851 } })) as unknown as typeof connection.simulateTransaction
  const wallet = phantomWallet(owner, 'in-place')
  const sign = wallet.signTransaction.bind(wallet)
  wallet.signTransaction = async value => {
    value.instructions.unshift(ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }))
    value.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 5_000 }))
    return sign(value)
  }
  const signed = await signDevnetTransaction(wallet, transaction, connection, undefined, true)
  assert.equal(signed.instructions.filter(instruction => instruction.programId.equals(ComputeBudgetProgram.programId)).length, 4)
  assert.ok(signed.verifySignatures())
})

test('post-sign validation accepts a backend CreateMandate transaction that Phantom adds a signature to', async () => {
  for (const mode of ['in-place', 'copy'] as const) {
    const programId = Keypair.generate().publicKey
    const owner = Keypair.generate()
    const wire = backendUnsignedWire(programId, owner.publicKey, Keypair.generate().publicKey.toBase58())
    const unsigned = Transaction.from(wire)
    assert.equal(unsigned.signatures[0].signature, null, 'wire zero placeholder parses to a null slot')

    const messageBefore = unsigned.serializeMessage()
    const fullBytesBefore = unsigned.serialize({ requireAllSignatures: false, verifySignatures: false })

    const signed = await signDevnetTransaction(phantomWallet(owner, mode), unsigned, devnetConnection())

    assert.ok(signed.verifySignatures(), `${mode}: Phantom signature must be valid`)
    assert.ok(Buffer.from(messageBefore).equals(signed.serializeMessage()), `${mode}: signed message must be byte-identical`)
    const fullBytesAfter = signed.serialize()
    assert.equal(Buffer.from(fullBytesBefore).equals(fullBytesAfter), false, `${mode}: full wire bytes change because a signature was added`)
    // The old, broken comparison would have rejected the transaction here.
  }
})

test('post-sign validation fails closed when the signed message changes or the wallet swaps', async () => {
  const programId = Keypair.generate().publicKey
  const build = () => {
    const owner = Keypair.generate()
    const unsigned = Transaction.from(backendUnsignedWire(programId, owner.publicKey, Keypair.generate().publicKey.toBase58()))
    return { owner, unsigned }
  }

  // Phantom silently alters the instruction data: the message no longer matches.
  {
    const { owner, unsigned } = build()
    const wallet = {
      isPhantom: true, publicKey: owner.publicKey,
      async signTransaction(transaction: Transaction) { transaction.instructions[0].data[9] = 1; transaction.partialSign(owner); return transaction },
    } as unknown as PhantomProvider
    await assert.rejects(signDevnetTransaction(wallet, unsigned, devnetConnection()), /Post-sign validation failed/)
  }

  // Phantom returns without signing.
  {
    const { owner, unsigned } = build()
    const wallet = { isPhantom: true, publicKey: owner.publicKey, async signTransaction(transaction: Transaction) { return transaction } } as unknown as PhantomProvider
    await assert.rejects(signDevnetTransaction(wallet, unsigned, devnetConnection()), /Post-sign validation failed/)
  }

  // The connected wallet changes while the prompt is open.
  {
    const { owner, unsigned } = build()
    const wallet = {
      isPhantom: true, publicKey: owner.publicKey,
      async signTransaction(transaction: Transaction) { transaction.partialSign(owner); return transaction },
    } as PhantomProvider
    const snapshot = snapshotTransaction(unsigned)
    const after = snapshotTransaction(unsigned)
    const checks = collectPostSignChecks(snapshot, after, unsigned, owner.publicKey.toBase58(), Keypair.generate().publicKey.toBase58())
    assert.equal(checks.connectedWalletEqual, false)
    assert.equal(checks.messageBytesEqual, true)
    void wallet
  }
})
