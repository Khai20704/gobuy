import { createHash } from 'node:crypto'
import { rwaIntentSchema, type RWAReply, type MandateSpendResponse } from '@gobuy/shared'
import { assetStore, type AssetStore } from '../../persistence/AssetStore.js'
import { InputError } from '../../schemas/search.js'
import { parseRWAIntent } from './RWAIntent.js'
import { RWARegistry } from './RWARegistry.js'
import { RWAService } from './RWAService.js'
import { JupiterQuoteService } from '../jupiter/JupiterQuoteService.js'
import { SOL_MINT, USDC_MINT } from '../jupiter/types.js'
import { normalizeIntentText } from '../acquisition/intentLanguage.js'
import type { VaultSpendRequest } from '../mandate/autonomousSpend.js'
import { deliveryService } from '../delivery/delivery.js'
import type { DeliveryInput, DeliveryService } from '../delivery/DeliveryService.js'
import { decimalUnits, deliveryUnits } from '../delivery/quantity.js'

export type RWAChatPlan = { owner: string; mandate: string; text: string; mint: string; symbol: string; amount: string;
  reference: string; reply: RWAReply; result?: RWAReply; delivery?: Omit<DeliveryInput, 'paymentSignature'> }

/** Real approved asset selection, followed by DEVNET SOL settlement only. Never claims token delivery. */
export class RWAChatSettlement {
  constructor(private readonly registry: RWARegistry, private readonly discovery: Pick<RWAService, 'discover'>,
    private readonly spend: (request: VaultSpendRequest) => Promise<MandateSpendResponse>,
    private readonly mandateAddress: (owner: string) => Promise<string>,
    private readonly quotes = new JupiterQuoteService(),
    private readonly plans: AssetStore<RWAChatPlan> = assetStore('rwaChatSettlements'),
    private readonly deliveries: Pick<DeliveryService, 'deliver'> = { deliver: (user, input) => deliveryService().deliver(user, input) }) {}

  async run(userId: string, input: { requestId: string; text: string; owner: string }): Promise<RWAReply> {
    let plan = await this.plans.get(userId, input.requestId)
    if (plan && (plan.owner !== input.owner || plan.text !== input.text)) throw new InputError('Mã yêu cầu không khớp ví hoặc nội dung ban đầu.')
    if (plan?.result && plan.result.status !== 'PENDING') return this.finish(userId, plan)
    if (!plan) {
      const intent = parseRWAIntent(input.text, this.registry.list())
      const reply = await this.discovery.discover(userId, input.text, input.owner)
      // Price-only, explicit search-only and conditional orders retain their existing behavior.
      const searchOnly = /\b(chi tim|chi xem|khong mua|khong chi|search only|do not buy|dont buy|don t buy)\b/.test(normalizeIntentText(input.text))
      if (!intent.amount || intent.quantity || intent.condition || searchOnly) return reply
      const selected = reply.recommendations?.find(item => item.withinBudget === true)
        ?? (reply.status === 'QUOTED' ? reply.asset : undefined)
      if (!selected) return reply
      if (!this.registry.isApprovedMint(selected.mint)) throw new InputError('RWA không còn được duyệt.')
      // USD wording is normalized to a USDC reference budget, not a claim of a fiat conversion.
      const amount = intent.currency === 'SOL' ? intent.amount
        : (await this.quotes.quote(USDC_MINT, SOL_MINT, intent.amount)).outAmount
      if (BigInt(amount) <= 0n) throw new InputError('Chưa quy đổi được ngân sách sang SOL.')
      const canonical = this.registry.list().find(asset => asset.mint === selected.mint)!
      let referencePrice = 'priceUsd' in selected ? selected.priceUsd : undefined
      if (!(typeof referencePrice === 'number' && Number.isFinite(referencePrice) && referencePrice > 0)) {
        if (canonical.mint.includes(':') || canonical.decimals === undefined) throw new InputError('Chưa có giá tham chiếu hợp lệ để tính số lượng token thử nghiệm. Chưa thanh toán.')
        const priceQuote = await this.quotes.quote(USDC_MINT, canonical.mint, '1000000')
        referencePrice = 1 / Number(decimalUnits(priceQuote.outAmount, canonical.decimals))
      }
      if (!Number.isFinite(referencePrice) || referencePrice <= 0) throw new InputError('Giá tham chiếu không hợp lệ. Chưa thanh toán.')
      const referenceBudget = intent.currency === 'USDC' ? intent.amount
        : (await this.quotes.quote(SOL_MINT, USDC_MINT, amount)).outAmount
      const usdAmount = decimalUnits(referenceBudget, 6), price = String(referencePrice)
      const quantity = deliveryUnits(usdAmount, price, 6)
      const delivery: Omit<DeliveryInput, 'paymentSignature'> = {
        id: input.requestId, owner: input.owner, kind: 'RWA', mode: 'RWA_TOKEN', name: canonical.name,
        sourceMint: canonical.mint, rawQuantity: quantity, decimals: 6,
        pricing: { amount: decimalUnits(intent.amount, intent.currency === 'SOL' ? 9 : 6), currency: intent.currency,
          paymentLamports: amount, referencePrice: price, referenceCurrency: 'USDC', referenceAmount: usdAmount,
          source: canonical.mint.includes(':') ? 'Dex Screener canonical asset reference; USD/USDC parity for demo' : 'Jupiter validated reference quote',
          observedAt: new Date().toISOString() },
      }
      const reference = `RWA demo ${selected.symbol} ${input.requestId}`
      await this.plans.put(userId, input.requestId, { owner: input.owner, mandate: await this.mandateAddress(input.owner), text: input.text,
        mint: selected.mint, symbol: selected.symbol, amount, reference, reply, delivery }, true)
      // Read the winning immutable plan: concurrent requests must use identical spend identifiers.
      plan = await this.plans.get(userId, input.requestId)
    }
    if (!plan || plan.owner !== input.owner || plan.text !== input.text) throw new InputError('Không đọc được kế hoạch chi tiêu khớp yêu cầu.')
    if (plan.mandate !== await this.mandateAddress(input.owner)) throw new InputError('Mandate đã thay đổi; không gửi lại khoản chi cũ trên mandate mới.')
    if (!this.registry.isApprovedMint(plan.mint)) throw new InputError('RWA đã bị thu hồi duyệt; chưa gửi khoản chi mới.')
    const canonical = this.registry.list().find(asset => asset.mint === plan!.mint)
    if (!canonical) throw new InputError('Missing approved RWA identity.')
    this.registry.verifyIdentity(canonical, input.owner)
    const result = await this.spend({ userId, owner: plan.owner, category: 'RWA', amountLamports: BigInt(plan.amount),
      reference: plan.reference, assetHash: createHash('sha256').update('RWA_DEMO:' + plan.mint).digest('hex') })
    const reply: RWAReply = { ...normalizeReply(plan.reply), id: input.requestId, status: result.status, network: 'devnet',
      signature: result.signature ?? undefined, warnings: ['Chỉ thanh toán demo trên Devnet. Không mua hoặc nhận RWA mainnet; không phát token test.'],
      message: `${result.message} RWA được chọn: ${plan.symbol} (${plan.mint}). Số tiền demo: ${Number(plan.amount) / 1e9} Devnet SOL ` +
        '(ngân sách USD dùng USDC làm tham chiếu quy đổi qua Jupiter). Không có RWA thật chuyển về ví. ' +
        (plan.reply.recommendations?.length === 1 ? 'Chỉ có một ứng viên được duyệt phù hợp; không phải kết luận đáng mua nhất.'
          : `Đã xét ${plan.reply.recommendations?.length ?? 1} ứng viên. Ưu tiên quote hợp lệ và tác động giá thấp nếu có; cùng điểm chọn theo symbol, không phải dự báo lợi nhuận.`) }
    await this.plans.put(userId, input.requestId, { ...plan, result: reply })
    return this.finish(userId, { ...plan, result: reply })
  }
  private async finish(userId: string, plan: RWAChatPlan): Promise<RWAReply> {
    const reply = normalizeReply(plan.result!)
    if (reply.status !== 'CONFIRMED') return { ...reply, phase: 'PAYMENT_PENDING' }
    if (!plan.delivery || !reply.signature) return { ...reply, status: 'PENDING', phase: 'DELIVERY_FAILED',
      message: 'Đã thanh toán. Đơn cũ thiếu giá/số lượng hoặc chữ ký đã lưu; cần đối soát trước khi cấp token. Không thanh toán lại.' }
    const delivery = await this.deliveries.deliver(userId, { ...plan.delivery, paymentSignature: reply.signature })
    return { ...reply, phase: delivery.phase, delivery, status: delivery.phase === 'COMPLETED' ? 'CONFIRMED' : 'PENDING',
      warnings: ['Devnet demo token only. Không đại diện quyền sở hữu RWA thật.'],
      message: `${delivery.message} ${delivery.quantity} token demo ${plan.symbol}; giá tham chiếu ${delivery.pricing?.referencePrice} USDC/token.` }
  }
}

function normalizeReply(reply: RWAReply): RWAReply {
  const clean = { ...reply }
  if (clean.intent) clean.intent = rwaIntentSchema.parse(clean.intent)
  // Old BSON records may also contain a null signature from a pending response.
  if (clean.signature == null) delete clean.signature
  return clean
}
