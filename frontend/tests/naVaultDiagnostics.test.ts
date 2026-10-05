import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Connection, Keypair, SystemProgram, Transaction, VersionedTransaction } from '@solana/web3.js'
import { DEVNET_GENESIS } from '@gobuy/shared'
import { cleanNaVaultTransaction, deserializeNaVaultTransaction, diagnoseNaVaultTransaction } from '../src/services/solana/naVaultDiagnostics.ts'
import { signDevnetTransaction } from '../src/services/solana/walletSafety.ts'
import type { PhantomProvider } from '../src/services/solana/phantom.ts'

test('clean transaction preserves message, removes signatures and reaches provider with empty slots and correct receiver', async () => {
  const signer = Keypair.generate()
  const original = new Transaction({ feePayer: signer.publicKey, recentBlockhash: Keypair.generate().publicKey.toBase58() })
    .add(SystemProgram.transfer({ fromPubkey: signer.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1 }))
  const unsigned = Transaction.from(original.serialize({ requireAllSignatures: false, verifySignatures: false }))
  assert.equal(unsigned.signatures.length, 1)
  assert.equal(unsigned.signatures[0].signature, null, 'wire zero placeholder becomes null')
  original.partialSign(signer)
  const clean = cleanNaVaultTransaction(original, 'clean-test')
  assert.deepEqual(clean.signatures, [])
  assert.deepEqual(clean.serializeMessage(), original.serializeMessage())
  const connection = new Connection('https://example.invalid')
  connection.getGenesisHash = async () => DEVNET_GENESIS
  connection.isBlockhashValid = async () => ({ context: { slot: 1 }, value: true })
  let called = false
  const wallet = {
    isPhantom: true, publicKey: signer.publicKey,
    async signTransaction(tx: Transaction) {
      assert.equal(this, wallet)
      assert.equal(tx, clean)
      assert.deepEqual(tx.signatures, [])
      assert.deepEqual(tx.serializeMessage(), original.serializeMessage())
      tx.partialSign(signer)
      called = true
      return tx
    },
  } as PhantomProvider
  const signed = await signDevnetTransaction(wallet, clean, connection, { trace: 'clean-test', cleanUnsigned: true })
  assert.ok(called)
  assert.ok(signed.verifySignatures())
})

test('legacy backend bytes and exact unsigned simulation message are preserved', async () => {
  const owner = Keypair.generate().publicKey
  const transaction = new Transaction({ feePayer: owner, recentBlockhash: Keypair.generate().publicKey.toBase58() })
    .add(SystemProgram.transfer({ fromPubkey: owner, toPubkey: Keypair.generate().publicKey, lamports: 1 }))
  const bytes = transaction.serialize({ requireAllSignatures: false, verifySignatures: false })
  const parsed = deserializeNaVaultTransaction(bytes.toString('base64'), 'test')
  assert.ok(parsed instanceof Transaction)
  assert.deepEqual(parsed.serializeMessage(), transaction.serializeMessage())
  const connection = new Connection('https://example.invalid')
  connection.getGenesisHash = async () => DEVNET_GENESIS
  let simulated = false
  connection.simulateTransaction = (async (copy: VersionedTransaction, config: unknown) => {
    simulated = true
    assert.equal(copy.version, 'legacy')
    assert.deepEqual(Buffer.from(copy.serialize()), bytes)
    assert.deepEqual(config, { commitment: 'confirmed', sigVerify: false, replaceRecentBlockhash: false })
    return { context: { slot: 1 }, value: { err: null, logs: ['complete log'] } }
  }) as typeof connection.simulateTransaction
  await diagnoseNaVaultTransaction(parsed, 'test', owner.toBase58(), connection)
  assert.ok(simulated)
  const versioned = new VersionedTransaction(transaction.compileMessage()).serialize()
  assert.equal(deserializeNaVaultTransaction(Buffer.from(versioned).toString('base64'), 'test').feePayer?.toBase58(), owner.toBase58())
})

test('simulation transport failures report reason and both unavailable result fields', async () => {
  const owner = Keypair.generate().publicKey
  const transaction = new Transaction({ feePayer: owner, recentBlockhash: owner.toBase58() })
    .add(SystemProgram.transfer({ fromPubkey: owner, toPubkey: owner, lamports: 1 }))
  const connection = new Connection('https://example.invalid')
  connection.getGenesisHash = async () => DEVNET_GENESIS
  connection.simulateTransaction = async () => { throw new Error('HTTP 403 https://rpc.invalid/private-token') }
  const output: string[] = []
  const original = console.error
  console.error = (...args) => { output.push(args.map(value => typeof value === 'string' ? value : JSON.stringify(value)).join(' ')) }
  try { await diagnoseNaVaultTransaction(transaction, 'test', owner.toBase58(), connection) }
  finally { console.error = original }
  const logs = output.join('\n')
  assert.match(logs, /HTTP 403/)
  assert.match(logs, /simulation.value.err: unavailable/)
  assert.match(logs, /simulation.value.logs: unavailable/)
  assert.doesNotMatch(logs, /private-token/)
})
