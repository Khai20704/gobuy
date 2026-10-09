// Exact payment identity only. Never calls a payment executor or creates a purchase.
import { mongoDatabase } from '../src/persistence/mongo.js'
import { deliveryService } from '../src/services/delivery/delivery.js'
import { AutonomousPurchaseService, type AutonomousPurchaseOrder } from '../src/services/acquisition/AutonomousPurchaseService.js'
import type { DeliveryPlan } from '../src/services/delivery/DeliveryService.js'
import { devnetRpc } from '../src/services/delivery/rpc.js'
import { assertDevnet, solanaConfig } from '@gobuy/shared'

const signature = process.argv[2]
if (!signature || !/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(signature)) throw new Error('Pass the exact existing payment signature, optionally followed by --resume.')
try {
  const db = await mongoDatabase.get()
  const orders = await db.collection<{ userId: string; value: AutonomousPurchaseOrder }>('autonomousPurchases')
    .find({ 'value.reply.result.signature': signature }).limit(2).toArray()
  if (orders.length !== 1) throw new Error(`Expected one exact payment match; found ${orders.length}. No delivery attempted.`)
  const { userId, value: order } = orders[0]
  const row = await db.collection<{ value: DeliveryPlan; lease?: { until: Date }; recovery?: unknown }>('deliveryPlans').findOne({ userId, 'value.id': order.reply.id, 'value.kind': 'NFT' })
  if (!row) throw new Error('Missing persisted NFT delivery plan. No substitute plan or purchase created.')
  const plan = row.value
  if (plan.paymentSignature !== signature || plan.owner !== order.owner || plan.sourceMint !== order.reply.selected.mint) throw new Error('Persisted payment/recipient/mint mismatch.')
  const rpc = devnetRpc(), config = solanaConfig(process.env)
  await assertDevnet(rpc, config)
  const status = (await rpc.getSignatureStatuses([signature], { searchTransactionHistory: true })).value[0]
  if (!status || status.err || !['confirmed', 'finalized'].includes(status.confirmationStatus ?? '')) throw new Error('Original payment signature cannot be confirmed. No delivery attempted.')
  const payment = await new AutonomousPurchaseService().status(userId, plan.id)
  if (payment.result.status !== 'CONFIRMED' || payment.result.signature !== signature) throw new Error('Payment receipt reconciliation did not confirm the original payment.')
  console.log(JSON.stringify({ orderId: plan.id, paymentStatus: 'confirmed', paymentSignature: signature,
    owner: plan.owner, sourceMint: plan.sourceMint, mode: plan.mode, leaseUntil: row.lease?.until, recovery: row.recovery,
    publicMetadataConfigured: Boolean(process.env.NFT_DEMO_PUBLIC_URL) }))
  if (process.argv.includes('--resume')) {
    const { metadataId: _, ...input } = plan
    const result = await deliveryService().deliver(userId, input, true)
    console.log(JSON.stringify({ phase: result.phase, recovery: result.recovery, mint: result.mint, deliverySignature: result.signature }))
  } else console.log('Read-only verification complete. Pass --resume to resume delivery only.')
} catch (error) {
  // SDK errors may contain provider URLs or transaction bytes. Only controlled messages leave this script.
  console.error(error instanceof Error && /^(Expected|Missing|Persisted|Original|Payment)/.test(error.message) ? error.message : 'Recovery check unavailable; inspect configuration/RPC/database access. No new payment was initiated.')
  process.exitCode = 1
} finally { await mongoDatabase.close() }
