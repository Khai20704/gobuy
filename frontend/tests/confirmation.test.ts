import assert from 'node:assert/strict'
import { test } from 'node:test'
import { requireConfirmation, UnconfirmedTransactionError } from '../src/services/solana/confirmation.ts'
const block = { blockhash: 'test-only-blockhash', lastValidBlockHeight: 10 }
test('does not complete verification before confirmation resolves', async () => {
  let resolve!: (value: { value: { err: unknown } }) => void
  let completed = false
  const pending = requireConfirmation({ confirmTransaction: () => new Promise(done => { resolve = done }) }, 'test-only-signature', block)
    .then(() => { completed = true })
  await Promise.resolve()
  assert.equal(completed, false)
  resolve({ value: { err: null } })
  await pending
  assert.equal(completed, true)
})
test('failed and unknown confirmations cannot produce approval', async () => {
  for (const connection of [
    { confirmTransaction: async () => ({ value: { err: { InstructionError: [0, 'Custom'] } } }) },
    { confirmTransaction: async () => { throw new Error('RPC timeout') } },
  ]) await assert.rejects(requireConfirmation(connection, 'test-only-signature', block), (error: unknown) => {
    assert.ok(error instanceof UnconfirmedTransactionError)
    assert.equal(error.signature, 'test-only-signature')
    return true
  })
})
