import { PublicKey, Transaction } from '@solana/web3.js'
import { getAssociatedTokenAddressSync } from '@solana/spl-token'
import { buildTensorLegacyBuyInstruction, type TensorBuyInstruction } from '@gobuy/tensor-adapter'
import {
  assertDevnet, autonomousNFTCandidateSchema, base58Encode, checkNftPurchaseAuthorization,
  explainNftPurchaseRejection, explainMandateRejection, maxAllowedDebit, TENSOR_MARKETPLACE_PROGRAM_ID,
  type NFTCandidate, type NftPurchaseResult, type NftPurchaseResultRejection,
} from '@gobuy/shared'
import { assetStore, type AssetStore } from '../../persistence/AssetStore.js'
import { InputError } from '../../schemas/search.js'
import { requiredMandateClient, type MandateProgramClient } from '../mandate/MandateProgramClient.js'
import { mandateVaultAddress } from '../mandate/MandateGuard.js'
import { rejectionCodeOf, rejectionFromLogs } from '../mandate/programErrors.js'
import { decodeNftPurchaseAuthorization, decodeNftPurchaseReceipt } from './nftPurchaseAccounts.js'
import { buyNftFromMandateInstruction, nftAuthorizationAddress, purchaseReceiptAddress } from './nftPurchaseInstructions.js'
import { orderIdFor } from './orderIdentity.js'
import { assertTensorBuyLegacyInstruction, IX_BUYER_TA, tensorRemainingAccounts } from './tensorBuyLegacyLayout.js'

/**
 * Genuine Devnet NFT purchase: the Vault PDA pays Tensor through the Na Vault CPI and the original
 * NFT is delivered to the mandate owner's associated token account.
 *
 * This path never mints a GoBuy DEMO NFT, never uses Cloudflare R2, never calls the old settlement
 * address, and never falls back to a simulated delivery. If no executable listing exists it returns
 * NO_EXECUTABLE_LISTING and sends nothing.
 *
 * Live broadcasting is off unless NFT_PURCHASE_LIVE_ENABLED=true. The order record is written
 * *before* anything is signed or sent, so an unknown outcome can only be reconciled, never
 * resubmitted: the on-chain receipt PDA (`init`) makes a duplicate purchase impossible anyway.
 */

/** Live execution is opt-in and defaults to off, so no worker can spend autonomously by accident. */
export function nftPurchaseLiveEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NFT_PURCHASE_LIVE_ENABLED?.trim().toLowerCase() === 'true'
}

export type NftPurchaseOrderStatus = 'RESERVED' | 'SUBMITTED' | 'CONFIRMED' | 'FAILED' | 'UNKNOWN'

/** Durable attempt record. Persisted before signing; never rewritten for a different order. */
export type NftPurchaseOrder = {
  orderId: string
  discoveryId: string
  owner: string
  mint: string
  listing: string
  seller: string
  priceLamports: string
  maxTotalDebitLamports: string
  receiptAddress: string
  status: NftPurchaseOrderStatus
  signature: string | null
  attempts: number
  createdAt: string
  updatedAt: string
  message: string
}

export type NftPurchaseRequest = { discoveryId: string; owner: string; candidate: NFTCandidate }

type Blocked = {
  discoveryId: string; mint: string; listing: string; seller: string; priceLamports: bigint
  status: NftPurchaseResult['status']; message: string; rejection?: NftPurchaseResultRejection | null
}

/**
 * The genuine purchase. Every check that can be made before a transaction exists is made first;
 * the program re-checks all of them on chain, and the receipt plus the delivery postcondition make
 * a partial outcome impossible.
 */
export class NftPurchaseService {
  constructor(
    private readonly client: () => MandateProgramClient = requiredMandateClient,
    private readonly build: typeof buildTensorLegacyBuyInstruction = buildTensorLegacyBuyInstruction,
    private readonly live: (env?: NodeJS.ProcessEnv) => boolean = nftPurchaseLiveEnabled,
    private readonly orders: AssetStore<NftPurchaseOrder> = assetStore<NftPurchaseOrder>('nftPurchaseOrders'),
  ) {}

  async existing(userId: string, discoveryId: string): Promise<NftPurchaseOrder | undefined> {
    return this.orders.get(userId, discoveryId)
  }

  private blocked(input: Blocked): NftPurchaseResult {
    return {
      orderId: orderIdFor(input.discoveryId).toString('hex'),
      status: input.status,
      deliveryMode: 'ORIGINAL_NFT_TRANSFER',
      network: 'devnet',
      marketplace: 'Tensor',
      mint: input.mint,
      listing: input.listing,
      seller: input.seller,
      priceLamports: input.priceLamports.toString(),
      maxTotalDebitLamports: input.priceLamports > 0n ? maxAllowedDebit(input.priceLamports).toString() : '0',
      signature: null,
      receipt: null,
      rejection: input.rejection ?? null,
      message: input.message,
    }
  }

  /** Read-only view of one attempt. A confirmed order is never re-submitted. */
  async status(userId: string, discoveryId: string): Promise<NftPurchaseResult> {
    const order = await this.orders.get(userId, discoveryId)
    if (!order) throw new InputError('Không tìm thấy đơn mua NFT gốc của tài khoản này.')
    return this.reconcile(userId, order)
  }

  private async reconcile(userId: string, order: NftPurchaseOrder): Promise<NftPurchaseResult> {
    const client = this.client()
    await assertDevnet(client.connection, { network: 'devnet', rpcUrl: client.connection.rpcEndpoint })
    const address = new PublicKey(order.receiptAddress)
    const info = await client.connection.getAccountInfo(address, 'confirmed')
    if (info) {
      if (!info.owner.equals(client.programId)) throw new InputError('Biên nhận on-chain không thuộc chương trình Na Vault.')
      const receipt = decodeNftPurchaseReceipt(order.receiptAddress, info.data)
      if (receipt.owner !== order.owner || receipt.mint !== order.mint || receipt.orderId !== order.orderId) {
        throw new InputError('Biên nhận on-chain không khớp đơn mua này. Cần kiểm tra thủ công; không mua lại.')
      }
      const signatures = await client.connection.getSignaturesForAddress(address, { limit: 10 }, 'confirmed')
      const signature = signatures.find(item => !item.err)?.signature ?? order.signature
      order.status = 'CONFIRMED'
      order.signature = signature
      order.updatedAt = new Date().toISOString()
      order.message = 'Đã mua NFT gốc trên Tensor Devnet và xác nhận biên nhận on-chain. NFT được chuyển trực tiếp vào ví của bạn.'
      await this.orders.put(userId, order.discoveryId, order)
      return this.result(order, receipt)
    }
    if (order.signature) {
      const status = (await client.connection.getSignatureStatuses([order.signature], { searchTransactionHistory: true })).value[0]
      if (status?.err) {
        order.status = 'FAILED'
        order.updatedAt = new Date().toISOString()
        order.message = 'Giao dịch mua NFT gốc thất bại trên Devnet. Không có biên nhận nào được ghi; không mua lại tự động.'
        await this.orders.put(userId, order.discoveryId, order)
        return this.result(order, null)
      }
    }
    return this.result(order, null)
  }

  private result(order: NftPurchaseOrder, receipt: NftPurchaseResult['receipt']): NftPurchaseResult {
    const status: NftPurchaseResult['status'] = order.status === 'CONFIRMED' ? 'CONFIRMED'
      : order.status === 'FAILED' ? 'FAILED'
      : order.status === 'UNKNOWN' ? 'PENDING' : 'PENDING'
    return {
      orderId: order.orderId,
      status,
      deliveryMode: 'ORIGINAL_NFT_TRANSFER',
      network: 'devnet',
      marketplace: 'Tensor',
      mint: order.mint,
      listing: order.listing,
      seller: order.seller,
      priceLamports: order.priceLamports,
      maxTotalDebitLamports: order.maxTotalDebitLamports,
      signature: order.signature,
      receipt,
      rejection: null,
      message: order.message,
    }
  }

  /**
   * Validates the order, reserves it durably, then - only when live execution is enabled - signs
   * with the executor and broadcasts. Nothing is sent before the reservation exists.
   */
  async purchase(userId: string, request: NftPurchaseRequest): Promise<NftPurchaseResult> {
    const parsed = autonomousNFTCandidateSchema.safeParse(request.candidate)
    if (!parsed.success) {
      throw new InputError('Listing không đủ điều kiện thực thi: '
        + parsed.error.issues.map(issue => issue.path.join('.') + ': ' + issue.message).join('; '))
    }
    const candidate = parsed.data
    const mint = candidate.mint
    const listing = candidate.marketplaceListing.listingId
    const seller = candidate.listing.seller
    const price = BigInt(candidate.listing.priceLamports)
    const base = { discoveryId: request.discoveryId, mint, listing, seller, priceLamports: price }

    // One order per discovery: a previous attempt can only be reconciled, never repeated.
    const previous = await this.orders.get(userId, request.discoveryId)
    if (previous) {
      if (previous.owner !== request.owner || previous.mint !== mint || previous.listing !== listing) {
        throw new InputError('Yêu cầu này đã gắn với ví hoặc listing khác. Na không mua lại.')
      }
      return this.reconcile(userId, previous)
    }
    if (price <= 0n) {
      return this.blocked({ ...base, status: 'NO_EXECUTABLE_LISTING', message: 'Listing không có giá SOL hợp lệ. Chưa tạo giao dịch.' })
    }

    const client = this.client()
    await assertDevnet(client.connection, { network: 'devnet', rpcUrl: client.connection.rpcEndpoint })
    const agent = client.agent
    if (!agent) throw new InputError('Chưa cấu hình ví agent Devnet. Chưa có giao dịch nào được gửi.')
    const mandate = await client.read(request.owner)
    if (!mandate) throw new InputError('Ví này chưa có mandate trên Solana Devnet.')
    if (mandate.owner !== request.owner) throw new InputError('Mandate không thuộc ví yêu cầu.')
    if (mandate.executor !== agent.publicKey.toBase58()) throw new InputError('Ví agent không phải executor đã được uỷ quyền.')
    const nowSeconds = Math.floor(Date.now() / 1000)
    if (!mandate.active || mandate.closed) {
      return this.blocked({ ...base, status: 'NOT_SUBMITTED', rejection: 'MandateNotActive',
        message: explainMandateRejection('MandateNotActive') })
    }
    if (mandate.expiresAt < nowSeconds) {
      return this.blocked({ ...base, status: 'NOT_SUBMITTED', rejection: 'MandateExpired',
        message: explainMandateRejection('MandateExpired') })
    }
    if (mandate.allowedCategory !== 'ANY' && mandate.allowedCategory !== 'NFT') {
      return this.blocked({ ...base, status: 'NOT_SUBMITTED', rejection: 'InvalidCategory',
        message: explainMandateRejection('InvalidCategory', { mandateCategory: mandate.allowedCategory, requestedCategory: 'NFT' }) })
    }

    // Versioned purchase authorization: an explicit, separate user approval. Existing settlement
    // mandates are never reinterpreted as permission to buy from arbitrary sellers.
    const mandateKey = new PublicKey(mandate.address)
    const authorizationAddress = nftAuthorizationAddress(client.programId, mandateKey)
    const authorizationInfo = await client.connection.getAccountInfo(authorizationAddress, 'confirmed')
    if (!authorizationInfo) {
      return this.blocked({ ...base, status: 'AUTHORIZATION_REQUIRED',
        message: 'Chưa có uỷ quyền mua NFT gốc cho mandate này. Bạn cần ký uỷ quyền mua NFT trước; chưa có giao dịch nào được gửi.' })
    }
    if (!authorizationInfo.owner.equals(client.programId)) {
      throw new InputError('Tài khoản uỷ quyền mua không thuộc chương trình Na Vault.')
    }
    const authorization = decodeNftPurchaseAuthorization(authorizationAddress.toBase58(), authorizationInfo.data)
    const verdict = checkNftPurchaseAuthorization({ authorization, mandate: mandate.address, owner: request.owner,
      executor: agent.publicKey.toBase58(), marketplace: TENSOR_MARKETPLACE_PROGRAM_ID, priceLamports: price, nowSeconds })
    if (!verdict.allowed) {
      return this.blocked({ ...base, status: 'NOT_SUBMITTED', rejection: verdict.rejection,
        message: explainNftPurchaseRejection(verdict.rejection) })
    }
    if (!this.live()) {
      return this.blocked({ ...base, status: 'PURCHASE_DISABLED',
        message: 'Mua NFT gốc đang tắt (NFT_PURCHASE_LIVE_ENABLED). Chưa có giao dịch nào được tạo.' })
    }

    // Verified listing: the vault pays, the owner receives. Build and re-check before reserving.
    const vault = mandateVaultAddress(client.programId, mandateKey)
    let tensor: TensorBuyInstruction
    try {
      tensor = await this.build(client.connection.rpcEndpoint, mint, mandate.owner, price, AbortSignal.timeout(20_000), vault.toBase58())
    } catch {
      return this.blocked({ ...base, status: 'NO_EXECUTABLE_LISTING',
        message: 'Không có listing Tensor Devnet khả dụng cho mint này ngay bây giờ. Chưa tạo giao dịch; hãy tìm lại sau.' })
    }
    const buyerTokenAccount = getAssociatedTokenAddressSync(new PublicKey(mint), new PublicKey(mandate.owner))
    assertTensorBuyLegacyInstruction(tensor, { payer: vault.toBase58(), buyer: mandate.owner,
      buyerTokenAccount: buyerTokenAccount.toBase58(), mint, listState: listing, seller, priceLamports: price })
    if (tensor.accounts[IX_BUYER_TA].address !== buyerTokenAccount.toBase58()) {
      throw new InputError('Tensor trả về tài khoản nhận NFT không phải ATA của chủ mandate. Na từ chối giao dịch.')
    }

    const orderId = orderIdFor(request.discoveryId)
    const now = new Date().toISOString()
    const order: NftPurchaseOrder = { orderId: orderId.toString('hex'), discoveryId: request.discoveryId, owner: mandate.owner,
      mint, listing, seller, priceLamports: price.toString(), maxTotalDebitLamports: verdict.ceilingLamports.toString(),
      receiptAddress: purchaseReceiptAddress(client.programId, mandateKey, orderId).toBase58(), status: 'RESERVED',
      signature: null, attempts: 0, createdAt: now, updatedAt: now, message: 'Đã giữ chỗ đơn mua NFT gốc. Chưa gửi giao dịch.' }
    // Persisted before anything is signed: an unknown outcome can only reconcile, never resubmit.
    await this.orders.put(userId, request.discoveryId, order, true)
    const stored = await this.orders.get(userId, request.discoveryId)
    if (!stored || stored.orderId !== order.orderId) return this.reconcile(userId, stored ?? order)

    const transaction = new Transaction({ feePayer: agent.publicKey,
      ...await client.connection.getLatestBlockhash('confirmed') })
      .add(buyNftFromMandateInstruction(client.programId, { executor: agent.publicKey, owner: mandate.owner, orderId,
        expectedMint: new PublicKey(mint), maxPriceLamports: price, tensorAccounts: tensorRemainingAccounts(tensor) }))
    transaction.sign(agent)
    order.attempts += 1
    order.status = 'SUBMITTED'
    order.updatedAt = new Date().toISOString()
    order.message = 'Đã ký và đang gửi giao dịch mua NFT gốc tới Devnet.'
    await this.orders.put(userId, request.discoveryId, order)

    let signature: string
    try {
      signature = await client.broadcast(transaction)
    } catch (error) {
      // A broadcast rejection (preflight/simulation) moved no lamport: terminal, never retried.
      const rejection = rejectionCodeOf(error)
      const simulated = (error as { message?: string })?.message?.startsWith('Simulation failed.') === true
      order.status = rejection || simulated ? 'FAILED' : 'UNKNOWN'
      order.signature = transaction.signature ? base58Encode(transaction.signature) : null
      order.updatedAt = new Date().toISOString()
      order.message = rejection ? explainMandateRejection(rejection)
        : simulated ? 'Devnet từ chối giao dịch trước khi thực thi. Không có SOL nào bị trừ khỏi Na Vault.'
        : 'Chưa xác định được kết quả gửi giao dịch. Kiểm tra Explorer trước khi thử lại; Na không gửi lại tự động.'
      await this.orders.put(userId, request.discoveryId, order)
      return this.result(order, null)
    }
    order.signature = signature
    order.updatedAt = new Date().toISOString()
    await this.orders.put(userId, request.discoveryId, order)

    let logs: readonly string[] | null
    try {
      logs = await client.confirm(signature, transaction.recentBlockhash, transaction.lastValidBlockHeight)
    } catch {
      order.status = 'UNKNOWN'
      order.updatedAt = new Date().toISOString()
      order.message = 'Đang chờ xác nhận Devnet. Na không gửi lại; hãy kiểm tra trạng thái đơn.'
      await this.orders.put(userId, request.discoveryId, order)
      return this.result(order, null)
    }
    if (logs) {
      const rejection = rejectionFromLogs(logs)
      order.status = 'FAILED'
      order.updatedAt = new Date().toISOString()
      order.message = rejection ? explainMandateRejection(rejection)
        : 'Giao dịch mua NFT gốc thất bại trên Devnet. Biên nhận và việc chuyển NFT đã bị huỷ toàn bộ.'
      await this.orders.put(userId, request.discoveryId, order)
      return this.result(order, null)
    }
    // The receipt is the authoritative proof; reconciliation reads it rather than trusting the send.
    return this.reconcile(userId, order)
  }
}
