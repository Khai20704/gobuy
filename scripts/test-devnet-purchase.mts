import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Connection, Keypair, Transaction } from '@solana/web3.js'
import { assertDevnet, solanaConfig } from '@gobuy/shared'
import { NftDemoService } from '../backend/src/services/nftDemo/NftDemoService.js'

// Opt-in: an ephemeral test wallet, public Devnet faucet, no user wallet access.
const config = solanaConfig(process.env)
const connection = new Connection(config.rpcUrl, { commitment: 'confirmed', disableRetryOnRateLimit: true })
await assertDevnet(connection, config)
const buyer = Keypair.generate()
console.log('Devnet test wallet:', buyer.publicKey.toBase58())
let drop: string
try { drop = await connection.requestAirdrop(buyer.publicKey, 1000000000) }
catch (error) { console.error('BLOCKED: Devnet faucet did not fund the test wallet.', error instanceof Error ? error.message : error); process.exit(2) }
const block = await connection.getLatestBlockhash()
assert.equal((await connection.confirmTransaction({ signature: drop, ...block }, 'confirmed')).value.err, null)
const service = new NftDemoService(await mkdtemp(join(tmpdir(), 'gobuy-devnet-')))
const before = await connection.getBalance(buyer.publicKey)
const id = crypto.randomUUID()
const proposal = await service.prepare(id, 'Mua tranh NFT dưới 1 SOL', buyer.publicKey.toBase58())
assert.equal(proposal.status, 'READY', proposal.message)
if (proposal.status !== 'READY') throw new Error(proposal.message)
assert.equal(await connection.getBalance(buyer.publicKey), before, 'Preparing must not spend funds')
const tx = Transaction.from(Buffer.from(proposal.quote.transaction, 'base64'))
await assertDevnet(connection, config)
tx.partialSign(buyer)
const wire = tx.serialize().toString('base64')
let receipt = await service.submit(id, wire)
for (let attempt = 0; receipt.status === 'PENDING' && attempt < 20; attempt++) {
  await new Promise(resolve => setTimeout(resolve, 1500))
  receipt = await service.status(id)
}
assert.equal(receipt.status, 'CONFIRMED', receipt.message)
const after = await connection.getBalance(buyer.publicKey)
assert.equal(before - after, receipt.totalLamports)
assert.ok(before - after >= proposal.quote.priceLamports)
await service.submit(id, wire)
assert.equal(await connection.getBalance(buyer.publicKey), after, 'Duplicate submit must not charge twice')
console.log(JSON.stringify({ before, after, receipt, explorer: `https://explorer.solana.com/tx/${receipt.signature}?cluster=devnet` }, null, 2))
