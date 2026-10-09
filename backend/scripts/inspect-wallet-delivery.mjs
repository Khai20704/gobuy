// Read-only diagnosis. Never prints credentials or signs/submits transactions.
import { MongoClient } from 'mongodb'
import { Connection, PublicKey } from '@solana/web3.js'
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token'
import { assertDevnet, solanaConfig } from '@gobuy/shared'

const client = new MongoClient(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 8000 })
try {
  await client.connect()
  const db = client.db(process.env.MONGODB_DB_NAME || 'gobuy')
  const wallets = await db.collection('walletAssociations').find({ 'value.address': /^9dJL3i/ }).toArray()
  console.log(JSON.stringify({ matchingWallets: wallets.length }))
  for (const wallet of wallets) {
    const user = wallet.userId, owner = wallet.value.address
    console.log(JSON.stringify({ owner }))
    for (const name of ['autonomousPurchases', 'rwaChatSettlements', 'deliveryPlans', 'deliveryViews', 'deliveryCompletions', 'assetPositions']) {
      const rows = await db.collection(name).find({ userId: user }).toArray()
      console.log(JSON.stringify({ collection: name, rows: rows.map(({ value: v }) => ({
        id: v.id ?? v.reply?.id ?? v.result?.id, owner: v.owner ?? v.walletAddress,
        status: v.reply?.result?.status ?? v.result?.status ?? v.phase,
        signature: v.reply?.result?.signature ?? v.result?.signature ?? v.signature ?? v.attempt?.signature,
        sourceMint: v.sourceMint ?? v.mint ?? v.reply?.selected?.mint,
        hasDeliveryPlan: Boolean(v.delivery), message: v.message ?? v.reply?.result?.message ?? v.result?.message,
      })) }))
    }
    const config = solanaConfig(process.env), rpc = new Connection(config.rpcUrl, 'confirmed')
    await assertDevnet(rpc, config)
    for (const programId of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
      const accounts = await rpc.getParsedTokenAccountsByOwner(new PublicKey(owner), { programId }, 'confirmed')
      console.log(JSON.stringify({ program: programId.toBase58(), holdings: accounts.value.map(row => ({
        mint: row.account.data.parsed.info.mint, amount: row.account.data.parsed.info.tokenAmount.amount,
      })) }))
    }
  }
} catch (error) { console.error(JSON.stringify({ error: error.name, code: error.code ?? null })); process.exitCode = 1 }
finally { await client.close() }
