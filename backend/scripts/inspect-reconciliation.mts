import { MongoClient } from 'mongodb'
import { requiredMandateClient } from '../src/services/mandate/MandateProgramClient.js'
import { serializeMandate } from '../src/services/mandate/MandateGuard.js'
const owner = '9dJL3iVoECg6yaAeCoF3wKBPbkJkQE1WEucKm2fZUcAE'
const dbClient = new MongoClient(process.env.MONGODB_URI!, { serverSelectionTimeoutMS: 10000 })
try {
  const db = dbClient.db(process.env.MONGODB_DB_NAME || 'gobuy')
  const orders = await db.collection('autonomousPurchases').find({ 'value.owner': owner }).toArray()
  const discoveries = await db.collection('assetDiscoveries').find({ 'value.reply.intent.action': 'BUY' }).sort({ _id: -1 }).limit(12).toArray()
  console.log(JSON.stringify({ orders: orders.map(row => ({ id: row.value.reply?.id, status: row.value.reply?.result?.status, signature: row.value.reply?.result?.signature, receiptAddress: row.value.receiptAddress })),
    discoveries: discoveries.map(row => ({ id: row.value.reply.id, text: row.value.text, expiresAt: row.value.reply.expiresAt,
      hasOrder: orders.some(order => order.userId === row.userId && order.value.reply?.id === row.value.reply.id) })),
    linked: !!await db.collection('walletAssociations').findOne({ 'value.address': owner, 'value.verified': true }),
    mandate: serializeMandate(await requiredMandateClient().read(owner)),
  }, null, 2))
} finally { await dbClient.close() }
