import { createHash, randomUUID } from 'node:crypto'
import { PublicKey } from '@solana/web3.js'
import { assertDevnet, autonomousNFTCandidateSchema, autonomousPurchaseResultSchema, checkMandateSpend,
  explainMandateRejection, mandateCategoryAllows, type AutonomousPurchaseResult, type NFTCandidate } from '@gobuy/shared'
import { assetStore, type AssetStore } from '../../persistence/AssetStore.js'
import { InputError } from '../../schemas/search.js'
import { requiredMandateClient, type MandateProgramClient } from '../mandate/MandateProgramClient.js'
import { mandateAddress, mandateVaultAddress, serializeMandate } from '../mandate/MandateGuard.js'
import { executeVaultSpend, spendIdFor } from '../mandate/autonomousSpend.js'
import { hexBytes, spendRecordAddress } from '../mandate/mandateInstructions.js'
import { decodeSpendRecord } from '../mandate/spendRecords.js'
import { AutonomousSpendBlockedError } from './AutonomousSpendBlockedError.js'
import { publicMetadataUrl, validateCoreUrls } from '../delivery/metadataUrl.js'

export type AutonomousPurchaseOrder = { executionToken: string; owner: string; assetHash: string; reference: string; receiptAddress: string; reply: AutonomousPurchaseResult;
  assetStandard?: 'TOKEN_2022' | 'METAPLEX_CORE'; metadataUri?: string; imageUri?: string; recipientWallet?: string; recipientVerifiedAt?: string; deliveryMode?: 'DEVNET_DEMO_MINT'; demoAcceptedAt?: string;
  refundedAt?: string; refundSignature?: string; settledAt?: string; settlementStatus?: string;
  recoveryReview?: { status: 'unsettled'; paymentSignature: string; reviewedAt: string; reviewedBy: string };
}
const disclaimer = 'Đây là Devnet autonomous spend demo từ Na Vault; chưa phải giao dịch mua NFT hoàn chỉnh và chưa xác nhận NFT đã chuyển vào ví. Không cần chữ ký Phantom lần hai.'

/**
 * The DEMO autonomous NFT flow is legacy: it paid the settlement recipient and then minted a GoBuy
 * DEMO NFT instead of buying the original listing.
 *
 * New orders must use the genuine purchase path (`/api/nft-purchases`, Na Vault -> Tensor -> the
 * owner's wallet). This switch exists only so an operator can still rehearse the old demo, and it
 * defaults to off. Orders already persisted keep reconciling either way: this never orphans an
 * in-flight attempt, it only refuses to start a new DEMO one.
 */
export function demoAutoPurchaseEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.GOBUY_DEMO_AUTOPURCHASE_ENABLED?.trim().toLowerCase() === 'true'
}

export class AutonomousPurchaseService {
  private readonly locks = new Set<string>()
  constructor(private readonly client: () => MandateProgramClient = requiredMandateClient,
    private readonly spend = executeVaultSpend, private readonly orders: AssetStore<AutonomousPurchaseOrder> = assetStore('autonomousPurchases')) {}

  async existing(userId: string, id: string) { return this.orders.get(userId, id) }

  /** Lamports already spent from the owner's mandate, read from chain. Reconciliation only. */
  async spentLamports(owner: string): Promise<bigint> {
    const mandate = await this.client().read(owner)
    return mandate?.spentLamports ?? 0n
  }

  async recoverMissing(userId: string, id: string, owner: string, raw: NFTCandidate, expiresAt: string) {
    const previous = await this.orders.get(userId, id)
    if (previous) return this.status(userId, id)
    if (this.locks.has(userId + ':' + id) || !Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) > Date.now()) throw new InputError('Request may still be preparing. Reconciliation is pending.')
    const selected = autonomousNFTCandidateSchema.parse(raw), client = this.client()
    await assertDevnet(client.connection, { network: 'devnet', rpcUrl: client.connection.rpcEndpoint })
    const mandate = await client.read(owner)
    if (!mandate) throw new InputError('Mandate unavailable; retry remains blocked.')
    const assetHash = createHash('sha256').update(selected.mint + ':' + selected.marketplaceListing.listingId).digest('hex')
    const reference = 'NFT demo ' + id, amount = BigInt(selected.listing.priceLamports)
    const receiptAddress = spendRecordAddress(client.programId, new PublicKey(mandate.address),
      hexBytes(spendIdFor(mandate.address, assetHash, amount, reference), 16, 'spendId')).toBase58()
    const address = new PublicKey(receiptAddress)
    const [info, signatures] = await Promise.all([client.connection.getAccountInfo(address, 'confirmed'),
      client.connection.getSignaturesForAddress(address, { limit: 10 }, 'confirmed')])
    const signature = signatures.find(item => !item.err)?.signature ?? null
    const safe = mandate.spentLamports === 0n && !info && signatures.length === 0
    const reply: AutonomousPurchaseResult = { id, execution: 'Devnet autonomous spend demo', network: 'devnet', selected,
      listingPriceLamports: amount.toString(), requestedSpendLamports: amount.toString(), actualSpendLamports: null,
      signedBy: 'Na Agent / executor', phantomSignatureRequired: false,
      result: { status: safe ? 'NOT_SUBMITTED' : 'PENDING', signature, rejection: null, spend: null,
        mandate: serializeMandate(mandate), message: safe ? 'Request was not submitted: mandate spent=0, no signature or receipt. A new BUY request is safe.'
          : 'Existing on-chain activity requires reconciliation. Do not submit another BUY.' } }
    // Retain a terminal record under the original discovery UUID; delayed POSTs cannot execute it.
    await this.orders.put(userId, id, { executionToken: randomUUID(), owner, assetHash, reference, receiptAddress, reply }, true)
    return this.status(userId, id)
  }

  async budgetForNamedPurchase(owner: string): Promise<bigint> {
    const client = this.client()
    await assertDevnet(client.connection, { network: 'devnet', rpcUrl: client.connection.rpcEndpoint })
    const mandate = await client.read(owner)
    if (!mandate || !mandate.active || mandate.closed || mandate.expiresAt < Date.now() / 1000) {
      throw new InputError('An ACTIVE, unexpired mandate is required for a named purchase without an explicit budget.')
    }
    const remaining = mandate.maxBudgetLamports - mandate.spentLamports
    if (remaining <= 0n) throw new InputError('Mandate has no remaining budget.')
    return remaining
  }

  async execute(userId: string, id: string, owner: string, raw: NFTCandidate, maximum: bigint,
    binding?: { recipientWallet: string; verifiedAt: string }): Promise<AutonomousPurchaseResult> {
    const key = userId + ':' + id
    if (this.locks.has(key)) throw new InputError('Devnet autonomous spend demo đang xử lý. Kiểm tra trạng thái, không tạo khoản chi mới.')
    this.locks.add(key)
    let reserved = false
    try {
      const previous = await this.orders.get(userId, id)
      if (previous) {
        if (previous.owner !== owner || previous.reply.selected.id !== raw.id) throw new InputError('Yêu cầu đã gắn với ví/listing khác.')
        return this.status(userId, id)
      }
      // A new order never falls back to the DEMO mint: it must go through the genuine purchase path,
      // where the vault pays Tensor and the original NFT lands in the owner's wallet.
      if (!demoAutoPurchaseEnabled()) {
        throw new InputError('Na không còn tạo NFT GoBuy demo cho đơn mới. Gửi yêu cầu mua NFT gốc qua mục mua NFT; '
          + 'Na Vault sẽ trả cho listing Tensor đã xác minh và NFT gốc vào thẳng ví Phantom của bạn. Chưa có SOL nào bị chi.')
      }
      if (!binding || binding.recipientWallet !== owner || !Number.isFinite(Date.parse(binding.verifiedAt))
        || !PublicKey.isOnCurve(new PublicKey(owner).toBytes())) throw new InputError('Verified Phantom recipient required before payment.')
      const imageUri = process.env.NFT_DEMO_IMAGE_URL
      const metadataUri = publicMetadataUrl(createHash('sha256').update(JSON.stringify([userId, 'NFT', id])).digest('hex'), imageUri)
      validateCoreUrls(metadataUri, imageUri)
      const parsed = autonomousNFTCandidateSchema.safeParse(raw)
      if (!parsed.success) throw new InputError('Invalid execution listing: ' + parsed.error.issues.map(issue => issue.path.join('.') + ': ' + issue.message).join('; '))
      const selected = parsed.data, amount = BigInt(selected.listing.priceLamports)
      try {
        for (const address of [selected.mint, selected.listing.seller, selected.marketplaceListing.listingId, selected.asset.owner]) new PublicKey(address)
      } catch { throw new InputError('Invalid mint, seller or listing public key.') }
      if (amount > maximum || maximum <= 0n) throw new InputError('Listing price exceeds the requested budget.')
      const observed = Date.parse(selected.listing.observedAt), verified = Date.parse(selected.asset.verifiedAt)
      if ([observed, verified].some(time => time < Date.now() - 120_000 || time > Date.now() + 5000)) throw new InputError('Listing/asset verification expired. Search again.')
      const client = this.client()
      await assertDevnet(client.connection, { network: 'devnet', rpcUrl: client.connection.rpcEndpoint })
      const mandate = await client.read(owner)
      if (!mandate) throw new InputError('Mandate does not exist. Autonomous execution blocked.')
      if (mandate.spentLamports > 0n) throw new InputError('Mandate already has spending. Reconcile the existing transaction before retrying BUY; no resubmission.')
      // NFT and RWA never cross. The program enforces the same rule; refusing here names both
      // categories before anything is signed or broadcast.
      if (!mandateCategoryAllows(mandate.allowedCategory, 'NFT')) {
        throw new InputError(explainMandateRejection('InvalidCategory', { mandateCategory: mandate.allowedCategory, requestedCategory: 'NFT' }))
      }
      const expectedMandate = mandateAddress(client.programId, owner)
      if (mandate.owner !== owner || mandate.address !== expectedMandate.toBase58()
        || mandate.vault !== mandateVaultAddress(client.programId, expectedMandate).toBase58()) throw new InputError('InvalidVault: mandate/owner/vault mismatch.')
      if (!client.agent || mandate.executor !== client.agent.publicKey.toBase58()) throw new InputError('Configured Na Agent is not the authorized executor.')
      if (!client.settlement || mandate.recipient !== client.settlement.toBase58()) throw new InputError('Mandate recipient does not match the configured demo settlement.')
      const verdict = checkMandateSpend({ mandate, amountLamports: amount, category: 'NFT', nowSeconds: Math.floor(Date.now() / 1000), vaultLamports: mandate.vaultLamports })
      if (!verdict.allowed) throw new InputError(verdict.rejection + ': ' + explainMandateRejection(verdict.rejection, {
        amountLamports: amount, remainingLamports: mandate.maxBudgetLamports - mandate.spentLamports,
        mandateCategory: mandate.allowedCategory, requestedCategory: 'NFT',
      }))
      const assetHash = createHash('sha256').update(selected.mint + ':' + selected.marketplaceListing.listingId).digest('hex')
      const reference = 'NFT demo ' + id
      const spendId = spendIdFor(mandate.address, assetHash, amount, reference)
      const receiptAddress = spendRecordAddress(client.programId, expectedMandate, hexBytes(spendId, 16, 'spendId')).toBase58()
      const reply: AutonomousPurchaseResult = { id, execution: 'Devnet autonomous spend demo', network: 'devnet', selected,
        deliveryMode: 'DEVNET_DEMO_MINT', recipientWallet: binding.recipientWallet,
        listingPriceLamports: amount.toString(), requestedSpendLamports: amount.toString(), actualSpendLamports: null,
        signedBy: 'Na Agent / executor', phantomSignatureRequired: false,
        result: { status: 'PENDING', signature: null, rejection: null, spend: null, mandate: serializeMandate(mandate), message: 'Đang kiểm tra xác nhận. ' + disclaimer } }
      const order: AutonomousPurchaseOrder = { executionToken: randomUUID(), owner, assetHash, reference, receiptAddress, reply,
        assetStandard: 'METAPLEX_CORE', metadataUri, imageUri, recipientWallet: binding.recipientWallet, recipientVerifiedAt: binding.verifiedAt, deliveryMode: 'DEVNET_DEMO_MINT', demoAcceptedAt: new Date().toISOString() }
      // Persist before any signing/broadcast. Unknown outcomes can only reconcile, never resubmit.
      reserved = true
      await this.orders.put(userId, id, order, true)
      if ((await this.orders.get(userId, id))?.executionToken !== order.executionToken) return this.status(userId, id)
      const result = await this.spend(client, { userId, owner, amountLamports: amount, category: 'NFT', assetHash, reference })
      reply.result = { ...result, message: result.message + '\n' + disclaimer }
      reply.actualSpendLamports = result.status === 'CONFIRMED' && result.spend ? result.spend.amountLamports : null
      await this.orders.put(userId, id, order)
      return autonomousPurchaseResultSchema.parse(reply)
    } catch (error) {
      if (!reserved && error instanceof InputError) throw new AutonomousSpendBlockedError(error.message)
      throw error
    } finally { this.locks.delete(key) }
  }

  /** Read-only reconciliation; polling cannot trigger another spend. */
  async status(userId: string, id: string): Promise<AutonomousPurchaseResult> {
    const order = await this.orders.get(userId, id)
    if (!order) throw new InputError('Không tìm thấy Devnet autonomous spend demo của tài khoản này.')
    const client = this.client()
    await assertDevnet(client.connection, { network: 'devnet', rpcUrl: client.connection.rpcEndpoint })
    order.reply.result.mandate = serializeMandate(await client.read(order.owner))
    if (order.reply.result.status !== 'PENDING' && !(order.reply.result.status === 'CONFIRMED' && !order.reply.result.signature)) return autonomousPurchaseResultSchema.parse(order.reply)
    const address = new PublicKey(order.receiptAddress)
    const info = await client.connection.getAccountInfo(address, 'confirmed')
    if (info) {
      if (!info.owner.equals(client.programId)) throw new InputError('Invalid spend receipt owner.')
      const receipt = decodeSpendRecord(order.receiptAddress, info.data)
      if (receipt.owner !== order.owner || receipt.assetHash !== order.assetHash || receipt.amountLamports !== order.reply.requestedSpendLamports
        || receipt.mandate !== order.reply.result.mandate?.address) throw new InputError('Spend receipt does not match request.')
      const signatures = await client.connection.getSignaturesForAddress(address, { limit: 10 }, 'confirmed')
      const signature = signatures.find(item => !item.err)?.signature ?? order.reply.result.signature
      order.reply.result = { status: 'CONFIRMED', signature, rejection: null, spend: { ...receipt, reference: order.reference, signature },
        mandate: serializeMandate(await client.read(order.owner)), message: 'Đã xác nhận Devnet autonomous spend demo. ' + disclaimer }
      order.reply.actualSpendLamports = receipt.amountLamports
      await this.orders.put(userId, id, order)
    } else if (order.reply.result.signature) {
      const status = (await client.connection.getSignatureStatuses([order.reply.result.signature], { searchTransactionHistory: true })).value[0]
      if (status?.err) {
        order.reply.result = { ...order.reply.result, status: 'FAILED', rejection: 'TransactionFailed',
          message: 'Devnet autonomous spend demo failed: ' + JSON.stringify(status.err),
          mandate: serializeMandate(await client.read(order.owner)) }
        await this.orders.put(userId, id, order)
      }
    }
    return autonomousPurchaseResultSchema.parse(order.reply)
  }
}
