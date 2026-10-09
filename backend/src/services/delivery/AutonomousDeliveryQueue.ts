import type { AutonomousPurchaseOrder } from '../acquisition/AutonomousPurchaseService.js'
import { AutonomousPurchaseService } from '../acquisition/AutonomousPurchaseService.js'
import { mongoDatabase, type DatabaseProvider } from '../../persistence/mongo.js'
import type { DeliveryService } from './DeliveryService.js'
import { deliveryService } from './delivery.js'

/** The pre-payment order is a durable outbox. Recover a crash before enqueue without spending again. */
export async function recoverAutonomousDeliveryQueue(database: DatabaseProvider = mongoDatabase.get,
  purchases: Pick<AutonomousPurchaseService, 'status'> = new AutonomousPurchaseService(),
  deliveries: Pick<DeliveryService, 'enqueue'> = deliveryService()) {
  const collection = (await database()).collection<{ _id: string; userId: string; value: AutonomousPurchaseOrder; deliveryQueued?: boolean; queueRetryAt?: Date }>('autonomousPurchases')
  const rows = await collection.find({ 'value.deliveryMode': 'DEVNET_DEMO_MINT', deliveryQueued: { $ne: true },
    'value.reply.result.status': { $in: ['PENDING', 'CONFIRMED'] },
    $or: [{ queueRetryAt: { $exists: false } }, { queueRetryAt: { $lte: new Date() } }],
  }).limit(20).toArray()
  for (const row of rows) {
    // Back off even on a failed RPC or process restart; this path never calls execute/spend.
    await collection.updateOne({ _id: row._id }, { $set: { queueRetryAt: new Date(Date.now() + 60000) } })
    try {
      const order = row.value
      if (order.recipientWallet !== order.owner || !order.recipientVerifiedAt || order.refundedAt || order.refundSignature || order.settledAt || order.settlementStatus) continue
      const payment = order.reply.result.status === 'CONFIRMED' && order.reply.result.signature ? order.reply : await purchases.status(row.userId, order.reply.id)
      if (payment.result.status !== 'CONFIRMED' || !payment.result.signature) continue
      await deliveries.enqueue(row.userId, {
        id: payment.id, owner: order.owner, kind: 'NFT', name: payment.selected.name, sourceMint: payment.selected.mint,
        ...(order.assetStandard ? { assetStandard: order.assetStandard, metadataUri: order.metadataUri, imageUri: order.imageUri } : {}), mode: 'DEVNET_DEMO_MINT', rawQuantity: '1', decimals: 0, paymentSignature: payment.result.signature,
        recipientWallet: order.recipientWallet, recipientVerifiedAt: order.recipientVerifiedAt,
        paymentLamports: payment.actualSpendLamports ?? payment.requestedSpendLamports,
      })
      await collection.updateOne({ _id: row._id }, { $set: { deliveryQueued: true } })
    } catch { console.warn('[DeliveryWorker] Payment outbox recovery deferred; no payment resubmitted.') }
  }
}
