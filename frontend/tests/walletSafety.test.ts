import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Connection, Keypair, SystemProgram, Transaction } from '@solana/web3.js'
import { DEVNET_GENESIS } from '@gobuy/shared'
import { signDevnetTransaction } from '../src/services/solana/walletSafety.ts'
import type { PhantomProvider } from '../src/services/solana/phantom.ts'

test('post-sign permits added signatures but rejects semantic changes, wallet changes and missing/invalid signatures', async () => {
  const signer = Keypair.generate()
  const connection = new Connection('https://example.invalid')
  connection.getGenesisHash = async () => DEVNET_GENESIS
  connection.isBlockhashValid = async () => ({ context: { slot: 1 }, value: true })
  for (const mode of ['in-place', 'copy', 'data', 'blockhash', 'payer', 'program', 'metas', 'count', 'signer', 'wallet', 'missing', 'invalid']) {
    const tx = new Transaction({ feePayer: signer.publicKey, recentBlockhash: Keypair.generate().publicKey.toBase58() })
      .add(SystemProgram.transfer({ fromPubkey: signer.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1 }))
    const wallet = { publicKey: signer.publicKey, async signTransaction(input: Transaction) {
      const signed = mode === 'copy' ? Transaction.from(input.serialize({ requireAllSignatures: false })) : input
      if (mode === 'data') signed.instructions[0].data[4] = 2
      if (mode === 'blockhash') signed.recentBlockhash = Keypair.generate().publicKey.toBase58()
      if (mode === 'payer') signed.feePayer = Keypair.generate().publicKey
      if (mode === 'program') signed.instructions[0].programId = Keypair.generate().publicKey
      if (mode === 'metas') signed.instructions[0].keys[1].isWritable = false
      if (mode === 'count') signed.add(signed.instructions[0])
      if (mode === 'signer') signed.instructions[0].keys[1].isSigner = true
      if (mode === 'wallet') wallet.publicKey = Keypair.generate().publicKey
      if (mode !== 'missing') signed.partialSign(signer)
      if (mode === 'invalid') signed.signatures[0].signature!.fill(0)
      return signed
    } } as PhantomProvider
    if (mode === 'in-place' || mode === 'copy') assert.ok((await signDevnetTransaction(wallet, tx, connection)).verifySignatures())
    else await assert.rejects(signDevnetTransaction(wallet, tx, connection), /Post-sign validation failed/, mode)
  }
})

test('wallet approval is blocked for a foreign RPC or foreign blockhash', async () => {
  const signer = Keypair.generate()
  const owner = signer.publicKey
  let signatures = 0
  const wallet = { publicKey: owner, signTransaction: async (tx: Transaction) => { signatures++; tx.partialSign(signer); return tx } } as PhantomProvider
  const connection = new Connection('https://example.invalid')
  const tx = new Transaction({ feePayer: owner, recentBlockhash: Keypair.generate().publicKey.toBase58() })
    .add(SystemProgram.transfer({ fromPubkey: owner, toPubkey: Keypair.generate().publicKey, lamports: 1 }))
  connection.getGenesisHash = async () => 'foreign'
  await assert.rejects(signDevnetTransaction(wallet, tx, connection))
  connection.getGenesisHash = async () => DEVNET_GENESIS
  connection.isBlockhashValid = async () => ({ context: { slot: 1 }, value: false })
  await assert.rejects(signDevnetTransaction(wallet, tx, connection), /not valid on Devnet/)
  assert.equal(signatures, 0)
  connection.isBlockhashValid = async () => ({ context: { slot: 1 }, value: true })
  await signDevnetTransaction(wallet, tx, connection)
  assert.equal(signatures, 1)
})

test('Phantom signing failures retain their cause and explain the failing stage', async () => {
  const owner = Keypair.generate().publicKey
  const transaction = new Transaction({ feePayer: owner, recentBlockhash: Keypair.generate().publicKey.toBase58() })
    .add(SystemProgram.transfer({ fromPubkey: owner, toPubkey: Keypair.generate().publicKey, lamports: 1 }))
  const connection = new Connection('https://example.invalid')
  connection.getGenesisHash = async () => DEVNET_GENESIS
  connection.isBlockhashValid = async () => ({ context: { slot: 1 }, value: true })
  for (const code of [-32603, -32002, -32003, 4900, 4100]) {
    const cause = Object.assign(new Error('Unexpected error'), { code })
    const wallet = { publicKey: owner, signTransaction: async () => { throw cause } } as unknown as PhantomProvider
    await assert.rejects(signDevnetTransaction(wallet, transaction, connection), error => {
      if (code === -32603) {
        assert.equal(error, cause)
        return true
      }
      assert.ok(error instanceof Error)
      assert.equal(error.cause, cause)
      assert.match(error.message, new RegExp(`mã ${code}`))
      assert.match(error.message, /GoBuy chưa gửi giao dịch/)
      return true
    })
  }
  const rejected = Object.assign(new Error('User rejected the request.'), { code: 4001 })
  const wallet = { publicKey: owner, signTransaction: async () => { throw rejected } } as unknown as PhantomProvider
  await assert.rejects(signDevnetTransaction(wallet, transaction, connection), error => error === rejected)
})
