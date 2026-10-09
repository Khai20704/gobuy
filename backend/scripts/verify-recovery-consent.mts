import { mongoDatabase } from '../src/persistence/mongo.js'
import { assetStore } from '../src/persistence/AssetStore.js'
import { DemoRecovery } from '../src/services/delivery/DemoRecovery.js'
import type { AutonomousPurchaseOrder } from '../src/services/acquisition/AutonomousPurchaseService.js'

/**
 * Verifies that the UI's replacement-consent request works for ONE existing order.
 *
 * It exercises the exact server path behind POST /api/acquisition/autonomous-spends/:id/demo-consent:
 * the same eligibility checks (recorded operator review, confirmed unrefunded payment, verified
 * purchaser wallet, original TRANSFER_NFT plan, no signed attempt, no completion) and the same
 * off-chain message. It then proves a bogus signature is refused, and finally removes the unused
 * single-use nonce so the database is left exactly as it was found.
 *
 * It never pays, never signs, never mints and never delivers.
 *
 *   node --env-file-if-exists=.env --import tsx scripts/verify-recovery-consent.mts <orderId>
 */

const ORDER_ID = process.argv[2]
if (!ORDER_ID || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(ORDER_ID)) {
  throw new Error('Pass the exact existing order UUID as the first argument.')
}

type Challenge = { id: string; orderId: string; recipient: string; payment: string; message: string; expiresAt: string }

const db = await mongoDatabase.get()
const order = await db.collection<{ userId: string; value: AutonomousPurchaseOrder }>('autonomousPurchases')
  .findOne({ 'value.reply.id': ORDER_ID })
if (!order) throw new Error('Order not found.')
const userId = order.userId, owner = order.value.owner

const challenges = assetStore<Challenge>('walletChallenges')
const recovery = new DemoRecovery(undefined, undefined, undefined, challenges)
let challenge: Challenge | undefined
try {
  // 1. The UI's consent request must now be granted.
  challenge = await recovery.challenge(userId, ORDER_ID, owner)

  const expected = [`Account: ${userId}`, `Order: ${ORDER_ID}`, `Recipient: ${owner}`,
    `Existing payment: ${order.value.reply.result.signature}`, 'Delivery mode: DEVNET_DEMO_MINT', `Nonce: ${challenge.id}`]
  const missing = expected.filter(line => !challenge!.message.includes(line))
  const stored = await challenges.get(userId, 'demo:' + challenge.id)
  if (!stored) throw new Error('Challenge was not persisted.')

  // 2. A signature that is not from the purchaser wallet must be refused, and must not burn the nonce.
  let rejectedBogusSignature = false
  try { await recovery.accept(userId, ORDER_ID, challenge.id, Buffer.alloc(64).toString('base64')) }
  catch (error) { rejectedBogusSignature = /purchaser wallet|Consent/.test(error instanceof Error ? error.message : '') }

  const nonceStillPresent = Boolean(await challenges.get(userId, 'demo:' + challenge.id))

  console.log(JSON.stringify({
    orderId: ORDER_ID, userId, recipient: owner,
    consentRequestable: true,
    challenge: { id: challenge.id, expiresAt: challenge.expiresAt, persisted: true },
    message: challenge.message,
    messageBindsAccountOrderRecipientPaymentModeAndNonce: missing.length === 0,
    missingBindings: missing,
    bogusSignatureRejected: rejectedBogusSignature,
    nonceSurvivedRejectedSignature: nonceStillPresent,
    liveDeliveryEnabled: process.env.DEVNET_DELIVERY_LIVE_ENABLED ?? null,
  }, null, 2))
} finally {
  // No signature was accepted, so remove the unused nonce. The next UI click creates a fresh one.
  if (challenge) await challenges.take(userId, 'demo:' + challenge.id)
  const residue = challenge ? await challenges.get(userId, 'demo:' + challenge.id) : undefined
  console.log(JSON.stringify({ nonceRemoved: !residue }, null, 2))
  await mongoDatabase.close()
}
