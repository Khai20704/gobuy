import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { devnetDeliverySchema, type DevnetDelivery, type PurchasePhase } from '@gobuy/shared'
import { assetStore, type AssetStore } from '../../persistence/AssetStore.js'
import { decimalUnits } from './quantity.js'
import { memoryDeliveryLease, type DeliveryLease } from './DeliveryLease.js'
import { retryableRpc } from './rpc.js'
import { demoImageUrl, publicMetadataUrl, validateCoreUrls } from './metadataUrl.js'
import { commitDemoReplacement } from './commitDemoReplacement.js'

export type DeliveryInput = {
  assetStandard?: 'TOKEN_2022' | 'METAPLEX_CORE'; metadataUri?: string; imageUri?: string;
  id: string; owner: string; kind: 'NFT' | 'RWA'; name: string; sourceMint: string;
  mode: 'TRANSFER_NFT' | 'DEMO_NFT' | 'RWA_TOKEN' | 'DEVNET_DEMO_MINT' | 'ORIGINAL_NFT_TRANSFER'; rawQuantity: string; decimals: number;
  paymentSignature: string; pricing?: DevnetDelivery['pricing']; image?: string; description?: string;
  recipientWallet?: string; recipientVerifiedAt?: string; paymentLamports?: string;
  recoveryConsent?: { challengeId: string; acceptedAt: string; recipientWallet: string; originalMode: string };
}
export type DeliveryPlan = DeliveryInput & { metadataId: string }
export type DeliveryAttempt = { mint: string; signature: string; wire: string; lastValidBlockHeight: number; standard: 'core' | 'spl'; program?: string }
export interface DeliveryChain {
  prepare(plan: DeliveryPlan): Promise<DeliveryAttempt>
  inspect(plan: DeliveryPlan, attempt: DeliveryAttempt): Promise<'confirmed' | 'pending' | 'confirming' | 'uncertain' | 'retryable' | 'failed'>
  send(attempt: DeliveryAttempt): Promise<void>
  holdings(plan: DeliveryPlan, attempt: DeliveryAttempt): Promise<{ ownership: DevnetDelivery['ownership']; balance: string }>
  assertNoExistingMint?(plan: DeliveryPlan): Promise<void>
}
type Completion = { attempt: DeliveryAttempt; confirmedAt: string }
type Event = { phase: PurchasePhase; at: string; signature?: string }
const isTemporaryRpcError = (message: string) => /429|too many requests|rate limit|RPC unavailable|timeout|timed out|fetch failed|ECONNRESET|503|502/i.test(message)
function safeDeliveryError(message: string) {
  if (/authority|custody|transferable|escrow/i.test(message)) return 'NFT_TRANSFER_AUTHORITY_REQUIRED'
  if (/does not exist/i.test(message)) return 'NFT_NOT_FOUND_ON_DEVNET'
  if (/metadata|public URL|image/i.test(message)) return 'PUBLIC_METADATA_REQUIRED'
  if (/funds|debit|credit/i.test(message)) return 'AGENT_DELIVERY_FUNDS_REQUIRED'
  if (/Devnet|genesis/i.test(message)) return 'DEVNET_CONFIGURATION_REQUIRED'
  return 'DELIVERY_REQUIRES_ATTENTION'
}

/** Immutable plans, signed attempts and completion markers survive restarts and concurrent workers.
 * Only the already-signed winning attempt is broadcast. Payment is deliberately not a dependency.
 */
export class DeliveryService {
  getPlan(user: string, id: string) { return this.plans.get(user, `NFT:${id}`) }
  async acceptDemoReplacement(user: string, id: string, recipient: string, signature: string,
    consent: NonNullable<DeliveryInput['recoveryConsent']>, verifyPayment: () => Promise<void>) {
    const key = `NFT:${id}`, lease = await this.leases.acquire(user, key)
    if (!lease) throw new Error('Delivery is being checked. Retry consent after the active check finishes.')
    let recovery: DevnetDelivery['recovery']
    try {
      const saved = await this.plans.get(user, key)
      if (!saved || saved.owner !== recipient || saved.paymentSignature !== signature || consent.recipientWallet !== recipient) throw new Error('Recovery recipient/payment mismatch.')
      if (saved.mode === 'DEVNET_DEMO_MINT' && saved.recoveryConsent) throw new Error('Recovery already approved; consent cannot be reused.')
      if (!['TRANSFER_NFT', 'ORIGINAL_NFT_TRANSFER'].includes(saved.mode)) throw new Error('Order is not eligible for replacement.')
      await verifyPayment()
      if (await this.completions.get(user, key)) throw new Error('Delivery already completed. Replacement blocked.')
      // Even an expired attempt might have succeeded on a pruned RPC. Never change its meaning or mint.
      for (let i = 0; i < 100; i++) if (await this.attempts.get(user, `${key}:${i}`)) throw new Error('Existing signed delivery needs reconciliation. Replacement blocked.')
      if (!this.chain.assertNoExistingMint) throw new Error('Mint reconciliation unavailable.')
      await this.chain.assertNoExistingMint(saved)
      const plan: DeliveryPlan = { ...saved, mode: 'DEVNET_DEMO_MINT', recipientWallet: recipient,
        recipientVerifiedAt: consent.acceptedAt, recoveryConsent: consent, rawQuantity: '1', decimals: 0 }
      await lease.check()
      // Plan and consent are one atomic document update; a crash cannot leave an unconsented demo plan.
      await this.commitReplacement(user, saved, plan)
      const view = await this.view(plan, 'DELIVERY_PENDING')
      recovery = { status: 'pending', retryCount: 0, nextRetryAt: new Date(this.now()).toISOString(), lastError: null, updatedAt: new Date(this.now()).toISOString() }
      view.recovery = recovery
      view.deliveryState = 'DELIVERY_PENDING'
      await this.views.put(user, key, view)
      return plan
    } finally { await lease.release(recovery!) }
  }
  constructor(private readonly chain: DeliveryChain,
    private readonly plans: AssetStore<DeliveryPlan> = assetStore('deliveryPlans'),
    private readonly attempts: AssetStore<DeliveryAttempt> = assetStore('deliveryAttempts'),
    private readonly completions: AssetStore<Completion> = assetStore('deliveryCompletions'),
    private readonly events: AssetStore<Event> = assetStore('deliveryEvents'),
    private readonly metadata: AssetStore<Record<string, unknown>> = assetStore('deliveryMetadata'),
    private readonly views: AssetStore<DevnetDelivery> = assetStore('deliveryViews'),
    private readonly leases: DeliveryLease = memoryDeliveryLease,
    private readonly now: () => number = Date.now,
    private readonly commitReplacement = commitDemoReplacement) {}

  private async event(user: string, id: string, phase: PurchasePhase, signature?: string) {
    await this.events.put(user, `${id}:${phase}`, { phase, at: new Date().toISOString(), ...(signature ? { signature } : {}) }, true)
  }
  /** Persist the immutable queue entry without signing or contacting the chain. */
  async enqueue(user: string, input: DeliveryInput): Promise<DevnetDelivery> {
    const saved = await this.savePlan(user, input)
    return await this.views.get(user, `${input.kind}:${input.id}`) ?? this.view(saved, 'DELIVERY_PENDING')
  }
  private async savePlan(user: string, input: DeliveryInput): Promise<DeliveryPlan> {
    if (!input.paymentSignature) throw new Error('Confirmed payment signature required for delivery.')
    if (input.mode === 'DEVNET_DEMO_MINT' && (!input.recipientWallet || input.recipientWallet !== input.owner || !input.recipientVerifiedAt)) throw new Error('Verified recipientWallet required for demo delivery.')
    const metadataId = createHash('sha256').update(JSON.stringify([user, input.kind, input.id])).digest('hex')
    const key = `${input.kind}:${input.id}`
    const plan: DeliveryPlan = { ...input, metadataId }
    if (input.assetStandard === 'METAPLEX_CORE') {
      const existing = await this.plans.get(user, key)
      plan.metadataUri = input.metadataUri ?? existing?.metadataUri ?? publicMetadataUrl(metadataId, process.env.NFT_DEMO_IMAGE_URL)
      plan.imageUri = input.imageUri ?? existing?.imageUri ?? process.env.NFT_DEMO_IMAGE_URL
      validateCoreUrls(plan.metadataUri, plan.imageUri)
    }
    await this.plans.put(user, key, plan, true)
    const saved = (await this.plans.get(user, key))!
    if (!isDeepStrictEqual(saved, plan)) throw new Error('Purchase delivery identity/price/recipient mismatch.')
    return saved
  }
  async deliver(user: string, input: DeliveryInput, retryAttention = false): Promise<DevnetDelivery> {
    const saved = await this.savePlan(user, input)
    const key = `${input.kind}:${input.id}`
    const lease = await this.leases.acquire(user, key)
    if (!lease) return await this.views.get(user, key) ?? this.view(saved, 'DELIVERY_PENDING')
    let reply: DevnetDelivery | undefined
    try {
      const previous = await this.views.get(user, key)
      // Manual checks share the schedule and lease with automatic recovery.
      if (previous?.recovery && ((!retryAttention && previous.recovery.status === 'requires_attention')
        || (previous.recovery.nextRetryAt && Date.parse(previous.recovery.nextRetryAt) > this.now()))) {
        reply = previous; return reply
      }
      await lease.check()
      const preparing = previous ? { ...previous } : await this.view(saved, 'DELIVERY_PENDING')
      preparing.recovery = { status: 'preparing', retryCount: previous?.recovery?.retryCount ?? 0,
        nextRetryAt: new Date(this.now()).toISOString(), lastError: null, updatedAt: new Date().toISOString() }
      preparing.deliveryState = saved.mode === 'DEVNET_DEMO_MINT' ? 'MINTING' : 'DELIVERY_PENDING'
      await this.views.put(user, key, preparing)
      reply = await this.process(user, saved, lease.check)
      await lease.check()
      const priorRetries = retryAttention && previous?.recovery?.status === 'requires_attention' ? 0 : previous?.recovery?.retryCount ?? 0
      const retryCount = reply.phase === 'COMPLETED' ? priorRetries : priorRetries + 1
      const attention = reply.phase === 'DELIVERY_FAILED' || retryCount >= 30
      reply.recovery = { status: reply.phase === 'COMPLETED' ? 'completed' : attention ? 'requires_attention'
        : reply.recovery?.status ?? 'retrying', retryCount,
        nextRetryAt: reply.phase === 'COMPLETED' || attention ? null
          : new Date(this.now() + Math.min(300000, 5000 * 2 ** Math.min(retryCount - 1, 6)) + Math.floor(Math.random() * 1000)).toISOString(),
        lastError: reply.recovery?.lastError ?? (attention ? 'DELIVERY_REQUIRES_ATTENTION' : null), updatedAt: new Date().toISOString() }
      if (attention && reply.phase !== 'COMPLETED') reply.message = 'Đã thanh toán; giao tài sản cần kiểm tra: ' + (reply.recovery.lastError ?? 'DELIVERY_REQUIRES_ATTENTION') + '. Không thanh toán lại.'
      reply.deliveryState = reply.phase === 'COMPLETED' ? 'DELIVERED' : attention ? 'REQUIRES_ATTENTION'
        : reply.signature ? 'DELIVERY_CONFIRMING' : 'DELIVERY_PENDING'
      await this.views.put(user, key, reply)
      return reply
    } finally { await lease.release(reply?.recovery) }
  }
  private async process(user: string, saved: DeliveryPlan, checkLease: () => Promise<void>): Promise<DevnetDelivery> {
    const input = saved, key = `${saved.kind}:${saved.id}`, metadataId = saved.metadataId
    await this.event(user, key, 'PAYMENT_CONFIRMED', input.paymentSignature)
    let attempt: DeliveryAttempt | undefined
    try {
      const completed = await this.completions.get(user, key)
      if (completed) return this.view(saved, 'COMPLETED', completed.attempt)
      await this.metadata.put('public', metadataId, {
        ...(input.assetStandard === 'METAPLEX_CORE' ? { assetStandard: 'METAPLEX_CORE' } : {}),
        name: `GoBuy Devnet Demo · ${input.name}`.slice(0, 80), symbol: input.kind === 'RWA' ? 'DEMO-RWA' : 'DEMO-NFT',
        description: `GoBuy simulation on Solana Devnet. Not the original marketplace NFT; no creator affiliation or verified collection. No real RWA ownership. ${input.mode === 'DEVNET_DEMO_MINT' ? '' : input.description ?? ''}`.slice(0, 2000),
        ...(input.mode === 'DEVNET_DEMO_MINT' ? { image: input.imageUri ?? demoImageUrl() } : input.image?.startsWith('https://') ? { image: input.image } : {}),
        attributes: [{ trait_type: 'Type', value: 'Demo / Simulated NFT' }, { trait_type: 'Reference name', value: input.name },
          { trait_type: 'Original asset (reference only)', value: input.sourceMint }, { trait_type: 'Network', value: 'Devnet demo' }],
      }, input.mode !== 'DEVNET_DEMO_MINT' || !!await this.attempts.get(user, `${key}:0`))
      await this.event(user, key, 'DELIVERY_PENDING')
      // Each retry consumes a distinct immutable slot. No live attempt is replaced or re-signed.
      for (let index = 0; index < 100; index++) {
        const attemptId = `${key}:${index}`
        attempt = await this.attempts.get(user, attemptId)
        if (!attempt) {
          await checkLease()
          const prepared = await this.chain.prepare(saved)
          const original = index > 0 ? await this.attempts.get(user, `${key}:0`) : undefined
          if (original && original.mint !== prepared.mint) throw new Error('Delivery mint changed (agent key/configuration changed). Restore the original delivery signer before retrying.')
          await checkLease()
          await this.attempts.put(user, attemptId, prepared, true)
          attempt = (await this.attempts.get(user, attemptId))!
        }
        const status = await this.chain.inspect(saved, attempt)
        if (status === 'confirmed') {
          await checkLease()
          await this.event(user, key, 'DELIVERY_CONFIRMED', attempt.signature)
          await this.completions.put(user, key, { attempt, confirmedAt: new Date().toISOString() }, true)
          await this.event(user, key, 'COMPLETED', attempt.signature)
          return this.view(saved, 'COMPLETED', attempt)
        }
        if (status === 'retryable') continue
        if (status === 'failed') throw new Error('Giao dịch cấp tài sản thất bại trên chain. Cần kiểm tra trước khi tiếp tục; không thanh toán lại.')
        if (status === 'pending') {
          await checkLease()
          try { await this.chain.send(attempt) }
          catch (error) {
            if (error instanceof Error && error.message.startsWith('LIVE_DEVNET_DELIVERY_DISABLED')) throw error
            if (retryableRpc(error)) throw error
            // Submission errors are not chain failure evidence. Inspect the same signature later.
            const pending = await this.view(saved, 'DELIVERY_PENDING', attempt)
            pending.recovery = { status: 'confirming', retryCount: 0, nextRetryAt: null,
              lastError: 'TRANSACTION_OUTCOME_UNKNOWN', updatedAt: new Date().toISOString() }
            return pending
          }
        }
        const pending = await this.view(saved, 'DELIVERY_PENDING', attempt)
        pending.recovery = { status: status === 'pending' ? 'submitted' : 'confirming', retryCount: 0,
          nextRetryAt: null, lastError: status === 'uncertain' ? 'TRANSACTION_OUTCOME_UNKNOWN' : null, updatedAt: new Date().toISOString() }
        return pending
      }
      throw new Error('Delivery retry limit reached; inspect Devnet transaction history.')
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'Delivery unavailable.'
      if (reason === 'DELIVERY_LEASE_LOST') throw error
      const temporary = retryableRpc(error)
      const phase = temporary ? 'DELIVERY_PENDING' : 'DELIVERY_FAILED'
      await this.event(user, key, phase, attempt?.signature)
      const failed = await this.view(saved, phase, attempt, temporary
        ? 'kết nối Devnet đang bận, chờ kiểm tra việc giao tài sản' : reason)
      failed.recovery = { status: temporary ? 'retrying' : 'requires_attention', retryCount: 0, nextRetryAt: null,
        lastError: /429|rate.limit/i.test(reason) ? 'RPC_RATE_LIMIT' : temporary ? 'RPC_UNAVAILABLE' : safeDeliveryError(reason),
        updatedAt: new Date().toISOString() }
      return failed
    }
  }
  private async view(plan: DeliveryPlan, phase: PurchasePhase, attempt?: DeliveryAttempt, reason?: string): Promise<DevnetDelivery> {
    let holdings: { ownership: DevnetDelivery['ownership']; balance?: string } = { ownership: 'unknown' }
    if (attempt && phase === 'COMPLETED') {
      try { holdings = await this.chain.holdings(plan, attempt) } catch { /* RPC failure is not ownership. */ }
    }
    return devnetDeliverySchema.parse({ id: plan.id, owner: plan.owner, kind: plan.kind, name: plan.name,
      sourceMint: plan.sourceMint, mint: attempt?.mint, quantity: decimalUnits(plan.rawQuantity, plan.decimals),
      rawQuantity: plan.rawQuantity, decimals: plan.decimals, network: 'devnet', simulated: !['TRANSFER_NFT', 'ORIGINAL_NFT_TRANSFER'].includes(plan.mode),
      deliveryMode: plan.mode, recipientWallet: plan.recipientWallet ?? plan.owner, paymentLamports: plan.paymentLamports,
      replacementAcceptedAt: plan.recoveryConsent?.acceptedAt,
      demoName: plan.mode === 'DEVNET_DEMO_MINT' ? `GoBuy Demo · ${plan.name}`.slice(0, 64) : undefined,
      phase, paymentSignature: plan.paymentSignature, signature: attempt?.signature, pricing: plan.pricing, ...holdings,
      payment: { status: 'confirmed', signature: plan.paymentSignature },
      message: plan.mode === 'DEVNET_DEMO_MINT' && !reason ? (phase === 'COMPLETED'
        ? (holdings.ownership === 'verified' ? 'Quyền sở hữu NFT đã xác minh trên Devnet. Chưa xác minh hiển thị trong Phantom Collectibles.' : 'Giao dịch giao tài sản đã hoàn tất. Chưa xác minh quyền sở hữu hiện tại hoặc hiển thị trong Phantom.') : 'Đã thanh toán; chờ xử lý giao NFT demo trên Devnet.')
        : phase === 'COMPLETED' ? 'Đã xác nhận giao tài sản trên Devnet. Tài sản demo không đại diện quyền sở hữu tài sản Mainnet.'
        : `Đã thanh toán; ${reason ?? 'đang chờ giao tài sản vào ví'}. Không thanh toán lại.`,
    })
  }
  async list(user: string) {
    const plans = await this.plans.list(user)
    return Promise.all(plans.map(async plan => {
      const completion = await this.completions.get(user, `${plan.kind}:${plan.id}`)
      if (completion) {
        const saved = await this.views.get(user, `${plan.kind}:${plan.id}`)
        // Status polling is database-only. Ownership was verified before writing completion.
        return saved?.phase === 'COMPLETED' ? saved : this.view(plan, 'COMPLETED', completion.attempt)
      }
      const stored = await this.views.get(user, `${plan.kind}:${plan.id}`)
      const saved = stored && (!stored.deliveryMode || stored.deliveryMode === plan.mode) && !plan.recoveryConsent ? stored
        : stored?.deliveryMode === plan.mode ? stored : undefined
      if (saved?.phase === 'DELIVERY_FAILED' && isTemporaryRpcError(saved.message)) {
        return { ...saved, phase: 'DELIVERY_PENDING' as const,
          message: 'Đã thanh toán; kết nối Devnet đang bận, chờ kiểm tra việc giao tài sản. Không thanh toán lại.' }
      }
      return saved ? { ...saved, deliveryMode: plan.mode, recipientWallet: plan.recipientWallet ?? plan.owner } : this.view(plan, 'DELIVERY_PENDING')
    }))
  }
  publicMetadata(id: string) { return this.metadata.get('public', id) }
}
