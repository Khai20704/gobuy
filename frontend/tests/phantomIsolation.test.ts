import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Connection, Keypair, SystemInstruction, Transaction, VersionedTransaction } from '@solana/web3.js'
import { DEVNET_GENESIS } from '@gobuy/shared'
import { runPhantomIsolation } from '../src/services/solana/phantomIsolation.ts'

test('isolation uses injected method, self-transfer and exact simulated message; distinguishes A/B without broadcasting', async () => {
  const owner = Keypair.generate().publicKey
  const connection = new Connection('https://example.invalid')
  connection.getGenesisHash = async () => DEVNET_GENESIS
  connection.getLatestBlockhash = async () => ({ blockhash: owner.toBase58(), lastValidBlockHeight: 100 })
  connection.sendTransaction = async () => { assert.fail('must not send') }
  connection.sendRawTransaction = async () => { assert.fail('must not broadcast') }
  let simulatedMessage: Uint8Array | undefined
  connection.simulateTransaction = (async (tx: VersionedTransaction) => {
    simulatedMessage = tx.message.serialize()
    return { context: { slot: 1 }, value: { err: null, logs: ['success'] } }
  }) as typeof connection.simulateTransaction
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  try {
    for (const outcome of ['A', 'B', 'rejected']) {
      const provider = {
        isPhantom: true, publicKey: owner,
        async signTransaction(tx: Transaction) {
          assert.equal(this, provider)
          assert.ok(tx instanceof Transaction)
          assert.deepEqual(tx.signatures, [])
          assert.deepEqual(Uint8Array.from(tx.serializeMessage()), Uint8Array.from(simulatedMessage!))
          assert.equal(tx.instructions.length, 1)
          const transfer = SystemInstruction.decodeTransfer(tx.instructions[0])
          assert.ok(transfer.fromPubkey.equals(owner) && transfer.toPubkey.equals(owner))
          assert.equal(transfer.lamports, 1n)
          if (outcome !== 'B') throw Object.assign(new Error('test error'), { code: outcome === 'A' ? -32603 : 4001 })
          return tx
        },
      }
      Object.defineProperty(globalThis, 'window', { configurable: true, value: { phantom: { solana: provider } } })
      if (outcome === 'rejected') await assert.rejects(runPhantomIsolation(owner.toBase58(), connection), { code: 4001 })
      else assert.equal(await runPhantomIsolation(owner.toBase58(), connection), outcome)
    }
  } finally {
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})
