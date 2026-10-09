import process from 'node:process'
import { createHash } from 'node:crypto'
import { PublicKey } from '@solana/web3.js'
import { assertDevnet, solanaConfig } from '@gobuy/shared'
import { mongoDatabase } from '../src/persistence/mongo.js'
import { requiredMandateClient } from '../src/services/mandate/MandateProgramClient.js'
import { decodeSpendRecord } from '../src/services/mandate/spendRecords.js'
import { devnetRpc } from '../src/services/delivery/rpc.js'
import type { AutonomousPurchaseOrder } from '../src/services/acquisition/AutonomousPurchaseService.js'
import type { DeliveryPlan, DeliveryAttempt } from '../src/services/delivery/DeliveryService.js'

/**
 * Read-only operator inspection of ONE existing autonomous purchase before a recovery review.
 *
 * It never writes, never signs, never mints and never calls a payment executor. It resolves the
 * exact order document by its public order id, then reports the finalized payment, the settlement
 * / refund fields, the delivery plan, every signed delivery attempt and any completion marker.
 *
 *   node --env-file-if-exists=.env --import tsx scripts/inspect-recovery-order.mts <orderId>
 *
 * The document _id mirrors AssetStore: sha256(`${userId}:${id}`). Verification therefore reads the
 * same primary key a conditional atomic update would target.
 */

process.env.MONGO_SKIP_INDEX_INIT = 'true'
const ORDER_ID = process.argv[2]
if (!ORDER_ID || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(ORDER_ID)) {
  throw new Error('Pass the exact existing order UUID (ad950e93-e5d5-48f4-9a1f-41becc680333).')
}
const key = (userId: string, id: string) => createHash('sha256').update(userId + ':' + id).digest('hex')

try {
  const db = await mongoDatabase.get()

  const matches = await db.collection<{ _id: string; userId: string; value: AutonomousPurchaseOrder }>('autonomousPurchases')
    .find({ 'value.reply.id': ORDER_ID }).limit(2).toArray()
  if (matches.length !== 1) throw new Error(`Expected exactly one order for ${ORDER_ID}; found ${matches.length}.`)
  const { _id: orderId, userId, value: order } = matches[0]

  const planKey = 'NFT:' + ORDER_ID
  const plans = await db.collection<{ _id: string; userId: string; value: DeliveryPlan; lease?: { token: string; until: Date }; recovery?: unknown }>('deliveryPlans')
    .find({ userId, 'value.id': ORDER_ID }).toArray()

  const attempts: { slot: number; attempt: DeliveryAttempt }[] = []
  for (let slot = 0; slot < 100; slot++) {
    const attempt = await db.collection<{ _id: string; userId: string; value: DeliveryAttempt }>('deliveryAttempts')
      .findOne({ _id: key(userId, `${planKey}:${slot}`), userId })
    if (attempt) attempts.push({ slot, attempt: attempt.value })
  }

  const completion = await db.collection<{ _id: string; userId: string; value: { attempt: DeliveryAttempt; confirmedAt: string } }>('deliveryCompletions')
    .findOne({ _id: key(userId, planKey), userId })

  const events = await db.collection<{ _id: string; userId: string; value: { phase: string; at: string; signature?: string } }>('deliveryEvents')
    .find({ userId, _id: { $in: ['PAYMENT_CONFIRMED', 'DELIVERY_PENDING', 'DELIVERY_CONFIRMED', 'COMPLETED', 'DELIVERY_FAILED']
      .map(phase => key(userId, `${planKey}:${phase}`)) } }).toArray()

  const view = await db.collection<{ _id: string; userId: string; value: Record<string, unknown> }>('deliveryViews')
    .findOne({ _id: key(userId, planKey), userId })

  const wallet = await db.collection<{ _id: string; userId: string; value: { address: string; verified: boolean } }>('walletAssociations')
    .findOne({ userId, 'value.address': order.owner })

  const paymentSignature = order.reply.result.signature
  const rpc = devnetRpc(), config = solanaConfig(process.env)
  await assertDevnet(rpc, config)

  const paymentStatus = paymentSignature
    ? (await rpc.getSignatureStatuses([paymentSignature], { searchTransactionHistory: true })).value[0]
    : null

  let receipt: { exists: boolean; owner?: string; ownerIsMandateProgram?: boolean; decoded?: unknown; error?: string } = { exists: false }
  if (order.receiptAddress) {
    try {
      const info = await rpc.getAccountInfo(new PublicKey(order.receiptAddress), 'confirmed')
      if (!info) receipt = { exists: false }
      else {
        const ownerIsMandateProgram = info.owner.equals(requiredMandateClient().programId)
        const decoded = ownerIsMandateProgram ? decodeSpendRecord(order.receiptAddress, info.data) : undefined
        receipt = { exists: true, owner: info.owner.toBase58(), ownerIsMandateProgram, ...(decoded ? { decoded } : {}) }
      }
    } catch (error) { receipt = { exists: false, error: error instanceof Error ? error.message : String(error) } }
  }

  const settlementWallet = requiredMandateClient().settlement?.toBase58() ?? null
  const plan = plans[0]?.value

  console.log(JSON.stringify({
    orderId: ORDER_ID,
    document: { collection: 'autonomousPurchases', _id: orderId, userId, expectedId: key(userId, ORDER_ID), idMatches: orderId === key(userId, ORDER_ID) },
    order: {
      owner: order.owner, assetHash: order.assetHash, reference: order.reference, receiptAddress: order.receiptAddress,
      recipientWallet: order.recipientWallet ?? null, recipientVerifiedAt: order.recipientVerifiedAt ?? null,
      deliveryMode: order.deliveryMode ?? null, demoAcceptedAt: order.demoAcceptedAt ?? null,
      refundedAt: order.refundedAt ?? null, refundSignature: order.refundSignature ?? null,
      settledAt: order.settledAt ?? null, settlementStatus: order.settlementStatus ?? null,
      recoveryReview: order.recoveryReview ?? null,
      recoveryConsent: (order as Record<string, unknown>).recoveryConsent ?? null,
    },
    payment: {
      status: order.reply.result.status, signature: paymentSignature,
      requestedLamports: order.reply.requestedSpendLamports, actualLamports: order.reply.actualSpendLamports,
      selectedName: order.reply.selected.name, selectedMint: order.reply.selected.mint,
      marketplaceListing: order.reply.selected.marketplaceListing,
      rpc: paymentStatus ? { confirmationStatus: paymentStatus.confirmationStatus ?? null, err: paymentStatus.err ?? null,
        slot: paymentStatus.slot ?? null } : null,
      receipt,
    },
    settlement: { settlementWallet, mandateRecipientMatchesSettlement: order.reply.result.mandate?.recipient === settlementWallet,
      mandateAddress: order.reply.result.mandate?.address ?? null, mandateSpentLamports: order.reply.result.mandate?.spentLamports ?? null },
    delivery: {
      planCount: plans.length,
      planId: plans[0]?._id ?? null, expectedPlanId: key(userId, planKey),
      leaseUntil: plans[0]?.lease?.until ?? null, recovery: plans[0]?.recovery ?? null,
      plan: plan ? { id: plan.id, kind: plan.kind, mode: plan.mode, owner: plan.owner, sourceMint: plan.sourceMint,
        paymentSignature: plan.paymentSignature, metadataId: plan.metadataId, recipientWallet: plan.recipientWallet ?? null,
        recoveryConsent: plan.recoveryConsent ?? null } : null,
      signedAttempts: attempts.map(row => ({ slot: row.slot, mint: row.attempt.mint, signature: row.attempt.signature,
        standard: row.attempt.standard, program: row.attempt.program ?? null, lastValidBlockHeight: row.attempt.lastValidBlockHeight })),
      completion: completion ? { confirmedAt: completion.value.confirmedAt, mint: completion.value.attempt.mint,
        signature: completion.value.attempt.signature } : null,
      view: view?.value ?? null,
      events,
    },
    walletAssociation: wallet ? { address: wallet.value.address, verified: wallet.value.verified } : null,
    config: { network: config.network, devnetDeliveryLiveEnabled: process.env.DEVNET_DELIVERY_LIVE_ENABLED ?? null,
      publicMetadataConfigured: Boolean(process.env.NFT_DEMO_PUBLIC_URL), nftDemoPublicUrl: process.env.NFT_DEMO_PUBLIC_URL ?? null },
  }, null, 2))
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Inspection unavailable; check configuration/RPC/database access.')
  process.exitCode = 1
} finally { await mongoDatabase.close() }
