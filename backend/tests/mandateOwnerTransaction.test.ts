import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ComputeBudgetProgram, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } from '@solana/web3.js'
import { assertExpectedOwnerTransaction, ownerInstructionsMatch } from '../src/services/mandate/ownerTransactions.ts'

/**
 * Phantom injects zero-account ComputeBudget instructions (compute unit limit / priority fee) while
 * signing an owner transaction. Those carry no account metas, so they cannot move SOL or touch the
 * mandate vault, and must not block a legitimate revoke/withdraw/create. Everything else the wallet
 * could do to the instruction list — adding an instruction with accounts, removing one, editing one,
 * or dropping the create ComputeBudget prefix — must still be refused.
 */

const PROGRAM = Keypair.generate().publicKey

function mandateInstruction(owner: PublicKey, data = 7): TransactionInstruction {
  return new TransactionInstruction({
    programId: PROGRAM,
    keys: [
      { pubkey: owner, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([1, 2, 3, data]),
  })
}

function computeBudgetPrefix(): TransactionInstruction[] {
  return [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 35_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 0 }),
  ]
}

function transactionWith(owner: Keypair, instructions: TransactionInstruction[]): Transaction {
  const transaction = new Transaction({ feePayer: owner.publicKey, blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 1 })
  transaction.add(...instructions)
  transaction.partialSign(owner)
  return transaction
}

test('an exact instruction list matches, and wallet ComputeBudget additions are ignored', () => {
  const owner = Keypair.generate()
  const expected = [mandateInstruction(owner.publicKey)]
  assert.equal(ownerInstructionsMatch(expected, [mandateInstruction(owner.publicKey)]), true)
  // Phantom prepends its own compute unit limit and priority fee before signing.
  assert.equal(ownerInstructionsMatch(expected, [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 5_000 }),
    mandateInstruction(owner.publicKey),
  ]), true)
})

test('the create ComputeBudget prefix is still required', () => {
  const owner = Keypair.generate()
  const expected = [...computeBudgetPrefix(), mandateInstruction(owner.publicKey)]
  assert.equal(ownerInstructionsMatch(expected, expected), true)
  assert.equal(ownerInstructionsMatch(expected, [mandateInstruction(owner.publicKey)]), false)
  assert.equal(ownerInstructionsMatch(expected, [ComputeBudgetProgram.setComputeUnitLimit({ units: 999 }), mandateInstruction(owner.publicKey)]), false)
})

test('removed, reordered and edited instructions never match', () => {
  const owner = Keypair.generate()
  const other = Keypair.generate().publicKey
  const expected = [mandateInstruction(owner.publicKey), mandateInstruction(other)]
  assert.equal(ownerInstructionsMatch(expected, [expected[1], expected[0]]), false)
  assert.equal(ownerInstructionsMatch(expected, [expected[0]]), false)
  assert.equal(ownerInstructionsMatch(expected, [mandateInstruction(owner.publicKey, 9), expected[1]]), false)
})

test('an added instruction that carries accounts is never treated as wallet configuration', () => {
  const owner = Keypair.generate()
  const sneaky = new TransactionInstruction({
    programId: ComputeBudgetProgram.programId,
    keys: [{ pubkey: owner.publicKey, isSigner: false, isWritable: true }],
    data: Buffer.from([9]),
  })
  assert.equal(ownerInstructionsMatch([mandateInstruction(owner.publicKey)], [sneaky, mandateInstruction(owner.publicKey)]), false)
  assert.equal(ownerInstructionsMatch([mandateInstruction(owner.publicKey)], [
    SystemProgram.transfer({ fromPubkey: owner.publicKey, toPubkey: owner.publicKey, lamports: 1 }),
    mandateInstruction(owner.publicKey),
  ]), false)
})

test('assertExpectedOwnerTransaction accepts Phantom ComputeBudget additions and rejects edits', () => {
  const owner = Keypair.generate()
  const expected = [mandateInstruction(owner.publicKey)]
  const accepted = transactionWith(owner, [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 5_000 }),
    mandateInstruction(owner.publicKey),
  ])
  assert.doesNotThrow(() => assertExpectedOwnerTransaction(accepted, expected, owner.publicKey))

  const edited = transactionWith(owner, [mandateInstruction(owner.publicKey, 9)])
  assert.throws(() => assertExpectedOwnerTransaction(edited, expected, owner.publicKey), /không khớp/)

  const wrongPayer = transactionWith(Keypair.generate(), [mandateInstruction(owner.publicKey)])
  assert.throws(() => assertExpectedOwnerTransaction(wrongPayer, expected, owner.publicKey), /không khớp ví đang kết nối/)
})
