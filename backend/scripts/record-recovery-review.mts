import process from 'node:process'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { PublicKey } from '@solana/web3.js'
import { assertDevnet, solanaConfig } from '@gobuy/shared'
import { mongoDatabase } from '../src/persistence/mongo.js'
import { requiredMandateClient } from '../src/services/mandate/MandateProgramClient.js'
import { decodeSpendRecord } from '../src/services/mandate/spendRecords.js'
import { devnetRpc } from '../src/services/delivery/rpc.js'
import type { AutonomousPurchaseOrder } from '../src/services/acquisition/AutonomousPurchaseService.js'
import type { DeliveryPlan } from '../src/services/delivery/DeliveryService.js'

/**
 * Operator tool that records the recoveryReview the existing legacy-recovery flow requires.
 *
 * It is deliberately NOT exposed over HTTP: the review asserts that no external refund and no
 * out-of-band delivery happened, and only an operator can attest to that. It never creates an
 * order, never debits the Vault, never signs, never mints and never calls a payment executor.
 *
 * Read-only unless --apply is passed. With --apply it performs ONE conditional atomic update of
 * the existing order document. The filter re-asserts live evidence, so a concurrent change to the
 * order, its payment, or its settlement fields makes the write match nothing and fail loudly.
 *
 *   node --env-file-if-exists=.env --import tsx scripts/record-recovery-review.mts \
 *     <orderId> --reviewed-by="<operator identity>" [--attestation-file=<path>] [--apply]
 */

process.env.MONGO_SKIP_INDEX_INIT = 'true'
const ORDER_ID = process.argv[2]
if (!ORDER_ID || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(ORDER_ID)) {
  throw new Error('Pass the exact existing order UUID as the first argument.')
}
const flag = (name: string) => {
  const prefix = `--${name}=`
  const match = process.argv.slice(3).find(argument => argument.startsWith(prefix))
  return match ? match.slice(prefix.length) : undefined
}
const APPLY = process.argv.includes('--apply')
if (process.env.DEVNET_DELIVERY_LIVE_ENABLED !== 'false') throw new Error('Live delivery must remain explicitly false.')
const REVIEWED_BY = flag('reviewed-by')?.trim() || null
const REVIEWED_AT = flag('reviewed-at')?.trim() || new Date().toISOString()
if (!Number.isFinite(Date.parse(REVIEWED_AT))) throw new Error('--reviewed-at must be an ISO timestamp.')

/** The operator's explicit confirmations, verbatim. Overridable with --attestation-file. */
const DEFAULT_ATTESTATION = [
  'Operator attestation for legacy NFT delivery recovery (recorded from the operator\'s explicit confirmation).',
  '1. The operator is the sole controller of the settlement wallet.',
  '2. The 0.04 SOL payment has not been refunded by the operator.',
  '3. No NFT or replacement asset has been delivered through another channel.',
  'This is an operator attestation, not independent on-chain proof. Where the legacy record has no refund',
  'ledger, absence of a refund field is not itself proof of no external settlement.',
].join('\n')
const ATTESTATION_FILE = flag('attestation-file')
const ATTESTATION = ATTESTATION_FILE ? (await readFile(ATTESTATION_FILE, 'utf8')).trim() : DEFAULT_ATTESTATION
if (!ATTESTATION) throw new Error('The operator attestation is empty.')

const key = (userId: string, id: string) => createHash('sha256').update(userId + ':' + id).digest('hex')
const planKey = 'NFT:' + ORDER_ID

const db = await mongoDatabase.get()
const matches = await db.collection<{ _id: string; userId: string; value: AutonomousPurchaseOrder }>('autonomousPurchases')
  .find({ 'value.reply.id': ORDER_ID }).limit(2).toArray()
if (matches.length !== 1) throw new Error(`Expected exactly one order for ${ORDER_ID}; found ${matches.length}. No review written.`)
const { _id: orderId, userId, value: order } = matches[0]
const expectedId = key(userId, ORDER_ID)
if (orderId !== expectedId) throw new Error('Order document id does not match AssetStore hashing. No review written.')

const results = order.reply.result
const paymentSignature = results.signature
if (results.status !== 'CONFIRMED' || !paymentSignature) throw new Error('Original payment is not CONFIRMED. No review written.')
if (order.refundedAt || order.refundSignature || order.settledAt
  || (order.settlementStatus && order.settlementStatus !== 'unsettled')) throw new Error('Order is refunded or otherwise settled. No review written.')
if (order.recoveryReview) throw new Error('A recoveryReview already exists on this order. Refusing to overwrite. No review written.')

const planRow = await db.collection<{ _id: string; value: DeliveryPlan }>('deliveryPlans').findOne({ userId, 'value.id': ORDER_ID, 'value.kind': 'NFT' })
if (!planRow) throw new Error('Missing persisted NFT delivery plan. No review written.')
const plan = planRow.value
if (plan.paymentSignature !== paymentSignature || plan.owner !== order.owner || plan.sourceMint !== order.reply.selected.mint) {
  throw new Error('Persisted payment/recipient/mint mismatch. No review written.')
}

const completion = await db.collection<{ _id: string; value: unknown }>('deliveryCompletions').findOne({ _id: key(userId, planKey), userId })
if (completion) throw new Error('Delivery already completed; the order is settled. No review written.')

const signedAttempts: { slot: number; mint: string; signature: string }[] = []
for (let slot = 0; slot < 100; slot++) {
  const attempt = await db.collection<{ _id: string; value: { mint: string; signature: string } }>('deliveryAttempts')
    .findOne({ _id: key(userId, `${planKey}:${slot}`), userId })
  if (attempt) signedAttempts.push({ slot, mint: attempt.value.mint, signature: attempt.value.signature })
}
if (signedAttempts.length) throw new Error('Signed delivery attempts require reconciliation before review.')
if (!['TRANSFER_NFT', 'ORIGINAL_NFT_TRANSFER'].includes(plan.mode)) throw new Error('Not an unconverted legacy order.')

const rpc = devnetRpc(), config = solanaConfig(process.env)
await assertDevnet(rpc, config)
const status = (await rpc.getSignatureStatuses([paymentSignature], { searchTransactionHistory: true })).value[0]
if (!status || status.err || status.confirmationStatus !== 'finalized') {
  throw new Error('Original payment cannot be confirmed on Devnet. No review written.')
}

const receiptInfo = await rpc.getAccountInfo(new PublicKey(order.receiptAddress), 'confirmed')
if (!receiptInfo || !receiptInfo.owner.equals(requiredMandateClient().programId)) {
  throw new Error('Payment receipt missing or not owned by the mandate program. No review written.')
}
const receipt = decodeSpendRecord(order.receiptAddress, receiptInfo.data)
if (receipt.owner !== order.owner || receipt.assetHash !== order.assetHash
  || receipt.amountLamports !== order.reply.requestedSpendLamports) throw new Error('Payment receipt identity mismatch. No review written.')

const settlementWallet = requiredMandateClient().settlement?.toBase58() ?? null
const transaction = await rpc.getTransaction(paymentSignature, { commitment: 'finalized', maxSupportedTransactionVersion: 0 })
const keys = transaction?.transaction.message.getAccountKeys({ accountKeysFromLookups: transaction.meta?.loadedAddresses }).keySegments().flat() ?? []
const destinationIndex = keys.findIndex(key => key.toBase58() === settlementWallet)
if (!transaction?.meta || transaction.meta.err || !keys.some(key => key.toBase58() === order.receiptAddress)
  || receipt.recipient !== settlementWallet || destinationIndex < 0
  || BigInt(transaction.meta.postBalances[destinationIndex] - transaction.meta.preBalances[destinationIndex]) !== BigInt(receipt.amountLamports)) {
  throw new Error('Original transaction does not prove the expected settlement credit.')
}
const mandate = results.mandate
if (!settlementWallet || mandate?.recipient !== settlementWallet) throw new Error('Mandate recipient does not match the configured settlement wallet. No review written.')
const observedAt = new Date().toISOString()
const review = { status: 'unsettled' as const, paymentSignature, reviewedAt: REVIEWED_AT, reviewedBy: REVIEWED_BY ?? '<required: pass --reviewed-by=...>' }
const audit = {
  recordedAt: observedAt,
  recordedBy: REVIEWED_BY,
  attestation: ATTESTATION,
  attestationKind: 'operator_attestation' as const,
  attestationScope: 'Not independent on-chain proof; accepted because the legacy record carries no refund ledger.',
  evidence: {
    orderDocumentId: orderId,
    userId,
    network: config.network,
    payment: { signature: paymentSignature, status: results.status, confirmationStatus: status.confirmationStatus ?? null,
      slot: status.slot ?? null, err: status.err ?? null, requestedLamports: order.reply.requestedSpendLamports,
      actualLamports: order.reply.actualSpendLamports },
    receipt: { address: order.receiptAddress, owner: receiptInfo.owner.toBase58(), decoded: receipt },
    asset: { name: order.reply.selected.name, mint: order.reply.selected.mint,
      marketplace: order.reply.selected.marketplaceListing.marketplace, listingId: order.reply.selected.marketplaceListing.listingId,
      seller: order.reply.selected.marketplaceListing.seller },
    settlement: { settlementWallet, transactionSlot: transaction.slot, verifiedCreditLamports: receipt.amountLamports, mandateAddress: mandate?.address ?? null,
      mandateRecipientMatchesSettlement: mandate?.recipient === settlementWallet, mandateSpentLamports: mandate?.spentLamports ?? null },
    refund: { refundedAt: order.refundedAt ?? null, refundSignature: order.refundSignature ?? null,
      settledAt: order.settledAt ?? null, settlementStatus: order.settlementStatus ?? null,
      ledger: 'absent on legacy record; absence is not proof, the operator attestation above covers it' },
    delivery: { planId: planKey, mode: plan.mode, sourceMint: plan.sourceMint,
      signedAttempts: signedAttempts.length, signedAttemptDetail: signedAttempts,
      completion: null, deliveryState: 'no completion marker and no signed attempt existed when this review was recorded' },
  },
}

const filter = {
  _id: expectedId, userId, 'value.reply.id': ORDER_ID, 'value.owner': order.owner,
  'value.reply.result.status': 'CONFIRMED', 'value.reply.result.signature': paymentSignature,
  'value.refundedAt': null, 'value.refundSignature': null, 'value.settledAt': null,
  'value.settlementStatus': { $in: [null, 'unsettled'] }, 'value.recoveryReview': { $exists: false },
}
const update = { $set: { 'value.recoveryReview': review, 'value.recoveryAudit': audit } }

console.log(JSON.stringify({
  mode: APPLY ? 'APPLY' : 'DRY RUN (nothing written)',
  orderId: ORDER_ID,
  collection: 'autonomousPurchases',
  documentId: expectedId,
  proposedReview: review,
  proposedAudit: audit,
  condition: filter,
  update,
  guarantees: {
    newPurchaseCreated: false,
    vaultDebited: false,
    paymentExecutorCalled: false,
    nftMintedOrDelivered: false,
    originalPaymentModified: false,
    otherCollectionsModified: false,
    devnetDeliveryLiveEnabled: process.env.DEVNET_DELIVERY_LIVE_ENABLED ?? null,
  },
}, null, 2))

if (!APPLY) {
  console.log('Dry run complete. Nothing was written. Re-run with --apply and --reviewed-by to record this review.')
} else {
  if (!REVIEWED_BY) throw new Error('Refusing to write without an identifiable operator reviewer. Pass --reviewed-by.')
  const result = await db.collection<{ _id: string; userId: string; value: AutonomousPurchaseOrder }>('autonomousPurchases').updateOne(filter, update)
  if (result.matchedCount !== 1) throw new Error('Conditional update matched no order; nothing was written. Re-inspect before retrying.')
  const saved = await db.collection<{ _id: string; value: AutonomousPurchaseOrder }>('autonomousPurchases').findOne({ _id: expectedId, userId })
  if (!saved) throw new Error('Order disappeared after the update. Inspect immediately.')
  console.log(JSON.stringify({
    applied: true, matchedCount: result.matchedCount, modifiedCount: result.modifiedCount,
    storedReview: saved.value.recoveryReview,
    originalPaymentUnchanged: saved.value.reply.result.signature === paymentSignature
      && saved.value.receiptAddress === order.receiptAddress && saved.value.owner === order.owner,
    settlementFieldsUnchanged: !saved.value.refundedAt && !saved.value.refundSignature && !saved.value.settledAt,
    deliveryModeUnchanged: saved.value.deliveryMode ?? null,
  }, null, 2))
}
await mongoDatabase.close()
