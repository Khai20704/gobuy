import process from 'node:process'
import { AcquisitionService } from '../src/services/acquisition/AcquisitionService.js'
import { mongoDatabase } from '../src/persistence/mongo.js'
import type { AutonomousPurchaseOrder } from '../src/services/acquisition/AutonomousPurchaseService.js'

/**
 * Read-only check of the exact payload the Na workspace receives for ONE order.
 *
 * It calls the same read-only reconciliation the browser calls
 * (GET /api/acquisition/autonomous-spends/:id?readOnly=true), then evaluates the render condition of
 * the "Nhận NFT demo thay thế" button on the returned delivery view. It writes nothing, signs
 * nothing, pays nothing and delivers nothing.
 *
 *   node --env-file-if-exists=.env --import tsx scripts/verify-ui-recovery-surface.mts <orderId>
 */

process.env.MONGO_SKIP_INDEX_INIT = 'true'
const ORDER_ID = process.argv[2]
if (!ORDER_ID || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(ORDER_ID)) {
  throw new Error('Pass the exact existing order UUID as the first argument.')
}

const LEGACY_TRANSFER_MODES = ['TRANSFER_NFT', 'ORIGINAL_NFT_TRANSFER']

try {
  const db = await mongoDatabase.get()
  const row = await db.collection<{ userId: string; value: AutonomousPurchaseOrder }>('autonomousPurchases')
    .findOne({ 'value.reply.id': ORDER_ID })
  if (!row) throw new Error('Order not found.')

  // The read-only reconciliation branch only reads the order store and the delivery list.
  const service = new AcquisitionService(undefined as never, undefined as never)
  const reply = await service.reconcilePurchase(row.userId, ORDER_ID, undefined, true)
  const delivery = reply.purchase?.delivery
  const purchase = reply.purchase

  const renderCondition = purchase ? {
    phaseIsNotCompleted: purchase.phase !== 'COMPLETED',
    hasPaymentSignature: Boolean(purchase.result.signature),
    hasActualSpend: purchase.actualSpendLamports !== null,
    purchaseModeIsNotDemoMint: purchase.deliveryMode !== 'DEVNET_DEMO_MINT',
    deliveryModeIsLegacyTransfer: LEGACY_TRANSFER_MODES.includes(delivery?.deliveryMode ?? ''),
  } : null
  const buttonRenders = Boolean(renderCondition && Object.values(renderCondition).every(Boolean))

  console.log(JSON.stringify({
    orderId: ORDER_ID,
    userId: row.userId,
    reconciliation: { status: reply.status, message: reply.message },
    purchase: purchase ? { phase: purchase.phase, deliveryMode: purchase.deliveryMode ?? null,
      actualSpendLamports: purchase.actualSpendLamports, paymentSignature: purchase.result.signature } : null,
    deliveryAsTheUiReceivesIt: delivery ? { id: delivery.id, phase: delivery.phase, deliveryMode: delivery.deliveryMode ?? null,
      recipientWallet: delivery.recipientWallet ?? null, replacementAcceptedAt: delivery.replacementAcceptedAt ?? null,
      simulated: delivery.simulated, recovery: delivery.recovery ?? null } : null,
    renderCondition,
    buttonRenders,
    liveDeliveryEnabled: process.env.DEVNET_DELIVERY_LIVE_ENABLED ?? null,
  }, null, 2))
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Check unavailable; inspect configuration/database access.')
  process.exitCode = 1
} finally { await mongoDatabase.close() }
