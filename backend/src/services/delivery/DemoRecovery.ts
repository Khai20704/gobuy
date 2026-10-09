import { createPublicKey, randomUUID, verify } from 'node:crypto'
import { PublicKey } from '@solana/web3.js'
import { assertDevnet, solanaConfig } from '@gobuy/shared'
import { assetStore, type AssetStore } from '../../persistence/AssetStore.js'
import { AutonomousPurchaseService, type AutonomousPurchaseOrder } from '../acquisition/AutonomousPurchaseService.js'
import { requiredMandateClient } from '../mandate/MandateProgramClient.js'
import { decodeSpendRecord } from '../mandate/spendRecords.js'
import { WalletAssociationService } from '../acquisition/WalletAssociationService.js'
import { deliveryService } from './delivery.js'
import { devnetRpc } from './rpc.js'
import type { DeliveryService } from './DeliveryService.js'
import { InputError } from '../../schemas/search.js'

type Challenge = { id: string; orderId: string; recipient: string; payment: string; message: string; expiresAt: string }
export class DemoRecovery {
  constructor(private readonly orders = new AutonomousPurchaseService(),
    private readonly wallets = new WalletAssociationService(),
    private readonly delivery: Pick<DeliveryService, 'getPlan' | 'acceptDemoReplacement'> = deliveryService(),
    private readonly challenges: AssetStore<Challenge> = assetStore('walletChallenges'),
    private readonly checkPayment = async (signature: string, order: AutonomousPurchaseOrder) => {
      const rpc = devnetRpc(); await assertDevnet(rpc, solanaConfig(process.env))
      const status = (await rpc.getSignatureStatuses([signature], { searchTransactionHistory: true })).value[0]
      if (!status || status.err || !['confirmed', 'finalized'].includes(status.confirmationStatus ?? '')) throw new Error('Payment cannot be confirmed on Devnet.')
      const address = new PublicKey(order.receiptAddress), info = await rpc.getAccountInfo(address, 'confirmed')
      if (!info || !info.owner.equals(requiredMandateClient().programId)) throw new Error('Payment receipt missing or invalid.')
      const receipt = decodeSpendRecord(order.receiptAddress, info.data)
      if (receipt.owner !== order.owner || receipt.assetHash !== order.assetHash || receipt.amountLamports !== order.reply.requestedSpendLamports) throw new Error('Payment receipt identity mismatch.')
      const transaction = await rpc.getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 })
      if (!transaction?.meta || transaction.meta.err || !transaction.transaction.message.getAccountKeys({ accountKeysFromLookups: transaction.meta.loadedAddresses }).keySegments()
        .flat().some(key => key.equals(address))) throw new Error('Payment transaction does not prove the original receipt.')
    }) {}
  private async eligible(user: string, id: string, recipient: string) {
    const order = await this.orders.existing(user, id)
    if (!order || order.owner !== recipient || (order.recipientWallet && order.recipientWallet !== recipient)) throw new Error('Original purchaser wallet required.')
    await this.wallets.require(user, recipient)
    if (order.refundedAt || order.refundSignature || order.settledAt || order.settlementStatus && order.settlementStatus !== 'unsettled') throw new Error('Order refunded or otherwise settled; replacement blocked.')
    if (order.reply.result.status !== 'CONFIRMED' || !order.reply.result.signature) throw new Error('Confirmed original payment required.')
    // Legacy orders have no refund ledger. Absence of a refund field is not proof of no external settlement.
    if (order.recoveryReview?.status !== 'unsettled'
      || order.recoveryReview.paymentSignature !== order.reply.result.signature || !order.recoveryReview.reviewedBy
      || !Number.isFinite(Date.parse(order.recoveryReview.reviewedAt))) throw new InputError('Đơn cũ chưa được người vận hành đối soát hoàn tiền/giao bù (operator review). Chưa thể ký nhận NFT thay thế. Không thanh toán lại.')
    const plan = await this.delivery.getPlan(user, id)
    if (!plan || plan.owner !== recipient || plan.paymentSignature !== order.reply.result.signature) throw new Error('Original delivery plan missing or mismatched.')
    if (!['TRANSFER_NFT', 'ORIGINAL_NFT_TRANSFER'].includes(plan.mode)) throw new Error('Recovery already approved or order is not a legacy transfer.')
    return { order, plan, payment: order.reply.result.signature }
  }
  async challenge(user: string, orderId: string, recipient: string) {
    const { payment, order } = await this.eligible(user, orderId, recipient)
    await this.checkPayment(payment, order)
    const id = randomUUID(), expiresAt = new Date(Date.now() + 300000).toISOString()
    const message = `GoBuy DEMO NFT replacement consent\nAccount: ${user}\nOrder: ${orderId}\nRecipient: ${recipient}\nNetwork: Solana Devnet\nDelivery mode: DEVNET_DEMO_MINT\nExisting payment: ${payment}\nI accept one clearly labeled Demo / Simulated NFT instead of the original marketplace NFT. No additional Vault payment.\nNonce: ${id}\nExpires: ${expiresAt}`
    const challenge = { id, orderId, recipient, payment, message, expiresAt }
    await this.challenges.put(user, 'demo:' + id, challenge, true)
    return challenge
  }
  async accept(user: string, orderId: string, challengeId: string, signature: string) {
    const challenge = await this.challenges.get(user, 'demo:' + challengeId)
    if (!challenge || challenge.orderId !== orderId || Date.parse(challenge.expiresAt) <= Date.now()) throw new Error('Consent expired or invalid.')
    const key = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), new PublicKey(challenge.recipient).toBuffer()]), format: 'der', type: 'spki' })
    const bytes = Buffer.from(signature, 'base64')
    if (bytes.length !== 64 || !verify(null, Buffer.from(challenge.message), key, bytes)) throw new Error('Consent signature does not match purchaser wallet.')
    const { plan, payment } = await this.eligible(user, orderId, challenge.recipient)
    if (challenge.payment !== payment) throw new Error('Payment identity changed.')
    return this.delivery.acceptDemoReplacement(user, orderId, challenge.recipient, payment,
      { challengeId, acceptedAt: new Date().toISOString(), recipientWallet: challenge.recipient, originalMode: plan.mode },
      async () => { const latest = await this.eligible(user, orderId, challenge.recipient); await this.checkPayment(payment, latest.order) })
  }
}
