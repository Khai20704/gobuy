import { createHash } from 'node:crypto'
import { mongoDatabase } from '../../persistence/mongo.js'
import type { DeliveryPlan } from './DeliveryService.js'

/** No fallback to separate writes: Mongo replica-set transactions are required for recovery. */
export async function commitDemoReplacement(userId: string, previous: DeliveryPlan, plan: DeliveryPlan,
  transaction = mongoDatabase.transaction.bind(mongoDatabase)) {
  const id = (key: string) => createHash('sha256').update(userId + ':' + key).digest('hex')
  const consent = plan.recoveryConsent!
  await transaction(async (db, session) => {
    const nonce = await db.collection('walletChallenges').deleteOne({ _id: id('demo:' + consent.challengeId) as any, userId,
      'value.orderId': plan.id, 'value.recipient': plan.owner, 'value.payment': plan.paymentSignature,
      'value.expiresAt': { $gt: new Date().toISOString() } }, { session })
    if (nonce.deletedCount !== 1) throw new Error('Consent expired or already used.')
    const order = await db.collection('autonomousPurchases').updateOne({ _id: id(plan.id) as any, userId,
      'value.owner': plan.owner, 'value.reply.result.signature': plan.paymentSignature, 'value.reply.result.status': 'CONFIRMED',
      'value.deliveryMode': { $ne: 'DEVNET_DEMO_MINT' },
      'value.refundedAt': null, 'value.refundSignature': null, 'value.settledAt': null,
      'value.settlementStatus': { $in: [null, 'unsettled'] },
      'value.recoveryReview.status': 'unsettled', 'value.recoveryReview.paymentSignature': plan.paymentSignature,
    }, { $set: { 'value.deliveryMode': 'DEVNET_DEMO_MINT', 'value.recipientWallet': plan.owner,
      'value.recipientVerifiedAt': consent.acceptedAt, 'value.recoveryConsent': consent,
      'value.reply.deliveryMode': 'DEVNET_DEMO_MINT', 'value.reply.recipientWallet': plan.owner,
      deliveryQueued: true } }, { session })
    if (order.matchedCount !== 1) throw new Error('Order changed or settlement review missing; recovery blocked.')
    const delivery = await db.collection('deliveryPlans').updateOne({ _id: id('NFT:' + plan.id) as any, userId,
      'value.mode': previous.mode, 'value.paymentSignature': plan.paymentSignature, 'value.owner': plan.owner,
    }, { $set: { value: plan, recovery: { status: 'pending', retryCount: 0, nextRetryAt: new Date().toISOString(),
      lastError: null, updatedAt: new Date().toISOString() } } }, { session })
    if (delivery.matchedCount !== 1) throw new Error('Delivery changed; recovery blocked.')
  })
}
