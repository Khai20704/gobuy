import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { ComputeBudgetProgram, Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } from '@solana/web3.js'
import { DEVNET_GENESIS } from '@gobuy/shared'
import { describeMessageDiff, diffMessageSnapshots, snapshotTransaction } from '../src/services/solana/messageSnapshot.ts'
import { signDevnetTransaction } from '../src/services/solana/walletSafety.ts'
import type { PhantomProvider } from '../src/services/solana/phantom.ts'

/**
 * Proves the two possible answers to "did Phantom change the message, or is our comparison wrong?":
 *  - A: a compliant wallet leaves the immutable primitive snapshots byte-identical except the
 *    signature slot, so the safety check passes.
 *  - B: a wallet that appends, removes or edits an instruction is reported exactly, and the
 *    transaction is never submitted.
 */

function discriminator(name: string) {
  return createHash('sha256').update('global:' + name).digest().subarray(0, 8)
}

function createMandateInstruction(programId: PublicKey, owner: PublicKey): TransactionInstruction {
  const [mandate] = PublicKey.findProgramAddressSync([Buffer.from('mandate'), owner.toBuffer()], programId)
  const [vault] = PublicKey.findProgramAddressSync([Buffer.from('vault'), mandate.toBuffer()], programId)
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: owner, isSigner: true, isWritable: true },
      { pubkey: mandate, isSigner: false, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([discriminator('create_mandate'), Buffer.alloc(8 + 8 + 1 + 32 + 32, 7)]),
  })
}

function unsignedMandateTransaction(programId: PublicKey, owner: Keypair): Transaction {
  const wire = new Transaction({ feePayer: owner.publicKey, blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 1 })
    .add(createMandateInstruction(programId, owner.publicKey))
    .serialize({ requireAllSignatures: false, verifySignatures: false })
  return Transaction.from(wire)
}

function devnetConnection(): Connection {
  const connection = new Connection('https://example.invalid')
  connection.getGenesisHash = async () => DEVNET_GENESIS
  connection.isBlockhashValid = async () => ({ context: { slot: 1 }, value: true })
  return connection
}

test('snapshots are detached primitives: mutating the transaction cannot rewrite an earlier snapshot', () => {
  const owner = Keypair.generate()
  const transaction = unsignedMandateTransaction(Keypair.generate().publicKey, owner)
  const before = snapshotTransaction(transaction)

  // Mutate the live objects the snapshot was taken from, then sign.
  transaction.instructions[0].data[9] = 1
  transaction.instructions[0].keys[0].pubkey = Keypair.generate().publicKey
  transaction.partialSign(owner)

  assert.equal(snapshotTransaction(transaction).messageHex === before.messageHex, false)
  assert.equal(before.instructions[0].dataHex.includes('01'), false, 'original snapshot data is untouched')
  assert.equal(before.instructions[0].keys[0].pubkey, owner.publicKey.toBase58(), 'original snapshot meta is untouched')
})

test('A: a compliant wallet leaves the message snapshots identical and passes validation', async () => {
  const programId = Keypair.generate().publicKey
  const owner = Keypair.generate()
  const transaction = unsignedMandateTransaction(programId, owner)
  const before = snapshotTransaction(transaction)

  const wallet = {
    isPhantom: true, publicKey: owner.publicKey,
    async signTransaction(value: Transaction) { value.partialSign(owner); return value },
  } as unknown as PhantomProvider

  const signed = await signDevnetTransaction(wallet, transaction, devnetConnection())
  const after = snapshotTransaction(signed)
  const diff = diffMessageSnapshots(before, after)

  assert.equal(diff.messagesEqual, true)
  assert.equal(diff.instructionsEqual, true)
  assert.deepEqual(diff.addedInstructions, [])
  assert.deepEqual(diff.removedInstructions, [])
  assert.deepEqual(diff.changedInstructions, [])
  assert.ok(signed.verifySignatures())
})

test('B: ComputeBudget instructions Phantom injects are allowed and classified as benign', async () => {
  const programId = Keypair.generate().publicKey
  const owner = Keypair.generate()
  const transaction = unsignedMandateTransaction(programId, owner)
  const before = snapshotTransaction(transaction)

  // Phantom-style injection: the wallet sets the compute unit limit and priority fee while signing.
  // Those instructions carry no accounts, so they cannot move SOL or touch the mandate.
  const wallet = {
    isPhantom: true, publicKey: owner.publicKey,
    async signTransaction(value: Transaction) {
      value.instructions.unshift(ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }))
      value.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1_000 }))
      value.partialSign(owner)
      return value
    },
  } as unknown as PhantomProvider

  const signed = await signDevnetTransaction(wallet, transaction, devnetConnection())
  assert.ok(signed.verifySignatures())
  const diff = diffMessageSnapshots(before, snapshotTransaction(signed))
  assert.equal(diff.instructionCountBefore, 1)
  assert.equal(diff.instructionCountAfter, 3)
  assert.equal(diff.computeBudgetAdded.length, 2)
  assert.deepEqual(diff.unexpectedAdded, [])
  assert.equal(diff.instructionsEqual, true)
  assert.equal(diff.messagesEqual, true)
  assert.match(describeMessageDiff(diff), /ComputeBudget/)
})

test('B: an appended NON-ComputeBudget instruction is named, and the transaction is not submitted', async () => {
  const programId = Keypair.generate().publicKey
  const owner = Keypair.generate()
  const transaction = unsignedMandateTransaction(programId, owner)
  const before = snapshotTransaction(transaction)

  const wallet = {
    isPhantom: true, publicKey: owner.publicKey,
    async signTransaction(value: Transaction) {
      value.add(SystemProgram.transfer({ fromPubkey: owner.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1 }))
      value.partialSign(owner)
      return value
    },
  } as unknown as PhantomProvider

  await assert.rejects(signDevnetTransaction(wallet, transaction, devnetConnection()), (error: unknown) => {
    assert.ok(error instanceof Error)
    assert.match(error.message, /noUnexpectedInstructionChanges/)
    assert.match(error.message, new RegExp(SystemProgram.programId.toBase58()))
    return true
  })

  const signed = Transaction.from(transaction.serialize({ requireAllSignatures: false, verifySignatures: false }))
  signed.partialSign(owner)
  const diff = diffMessageSnapshots(before, snapshotTransaction(signed))
  assert.equal(diff.instructionCountBefore, 1)
  assert.equal(diff.instructionCountAfter, 2)
  assert.equal(diff.unexpectedAdded.length, 1)
  assert.equal(diff.computeBudgetAdded.length, 0)
  assert.equal(diff.instructionsEqual, false)
  assert.match(describeMessageDiff(diff), new RegExp(SystemProgram.programId.toBase58()))
})

test('B: a removed instruction is reported as removed', () => {
  const programId = Keypair.generate().publicKey
  const owner = Keypair.generate()
  const transaction = unsignedMandateTransaction(programId, owner)
  // Two identical-shape instructions, then drop the second.
  transaction.add(createMandateInstruction(programId, owner.publicKey))
  const before = snapshotTransaction(transaction)
  transaction.instructions = [transaction.instructions[0]]
  const diff = diffMessageSnapshots(before, snapshotTransaction(transaction))

  assert.equal(diff.instructionCountAfter, 1)
  assert.equal(diff.removedInstructions.length, 1)
  assert.equal(diff.addedInstructions.length, 0)
})

test('B: a mutated instruction is reported as changed with the exact field', () => {
  const programId = Keypair.generate().publicKey
  const owner = Keypair.generate()
  const transaction = unsignedMandateTransaction(programId, owner)
  const before = snapshotTransaction(transaction)
  transaction.instructions[0].data[12] = 99
  const diff = diffMessageSnapshots(before, snapshotTransaction(transaction))

  assert.equal(diff.changedInstructions.length, 1)
  assert.equal(diff.changedInstructions[0].index, 0)
  assert.deepEqual(diff.changedInstructions[0].fields, ['data'])
  assert.equal(diff.messagesEqual, false)
})
