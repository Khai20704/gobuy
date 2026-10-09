import { randomUUID } from 'node:crypto'
import type { RWAIntent, RWAOrder, RWAReply, RWAAsset } from '@gobuy/shared'
import { assetStore, type AssetStore } from '../../persistence/AssetStore.js'
import { InputError } from '../../schemas/search.js'
import { AssetResolver, type AssetResolution } from './AssetResolver.js'
import { RWAConditionalOrders, isTerminalStatus, quantityUnits } from './RWAConditionalOrders.js'
import { parseRWAIntent } from './RWAIntent.js'
import { RWARegistry } from './RWARegistry.js'
import { filterApprovedByCategory, rankApprovedCandidates, type PricedCandidate } from './RWARecommendation.js'
import { JupiterQuoteService } from '../jupiter/JupiterQuoteService.js'
import { SOL_MINT, USDC_MINT } from '../jupiter/types.js'
import { DexScreenerPrices } from './DexScreenerPrices.js'

const USDC_DECIMALS = 6
const SOL_DECIMALS = 9

/** Atomic units to the decimal a user typed, so a ceiling is never shown as 1000000000 SOL. */
function formatAtomic(value: string, decimals: number) {
  const base = 10n ** BigInt(decimals), raw = BigInt(value)
  const fraction = (raw % base).toString().padStart(decimals, '0').replace(/0+$/, '')
  return fraction ? `${raw / base}.${fraction}` : (raw / base).toString()
}

/** Persisted RWA reply record. Exported so the store can be injected in tests. */
export type SavedRWA = { reply: RWAReply; intent: RWAIntent; owner: string }
/** The owner's on-chain mandate, read through the Na Vault client. */
export type MandateView = { active: boolean; remainingLamports: bigint; allowedCategory: 'NFT' | 'RWA' | 'ANY' }

/**
 * RWA identity and conditional orders.
 *
 * Layer split, never mixed:
 *  - RWA_APPROVED_LIST decides identity (an exact approved mint is the ONLY thing that makes a token
 *    an RWA). Liquidity, volume, popularity and market cap are never used for authenticity.
 *  - Jupiter is the market/execution layer: prices and routes only, never the trust authority.
 *  - The GoBuy Vault/mandate is the policy layer that would enforce a spend.
 *
 * Execution from the controlled Vault needs a Jupiter CPI the Anchor program does not have, so a
 * satisfied condition is revalidated and then reported as EXECUTION_UNAVAILABLE. Nothing here ever
 * fabricates a fill, a transfer or a CONFIRMED status.
 */
export type RWAServiceOptions = {
  quotes?: JupiterQuoteService
  orders?: RWAConditionalOrders
  cached?: AssetStore<SavedRWA>
  feeReserve?: number
  /** Reads the owner's on-chain mandate so the policy layer can be re-checked before spending. */
  mandate?: (owner: string) => Promise<MandateView | null>
  resolver?: AssetResolver
  referencePrices?: Pick<DexScreenerPrices, 'lookup'>
}

export class RWAService {
  private readonly quotes: JupiterQuoteService
  private readonly orders: RWAConditionalOrders
  private readonly cached: AssetStore<SavedRWA>
  private readonly feeReserve: number
  private readonly mandate: (owner: string) => Promise<MandateView | null>
  private readonly resolver: AssetResolver
  private readonly referencePrices: Pick<DexScreenerPrices, 'lookup'>

  constructor(private readonly registry: RWARegistry, options: RWAServiceOptions = {}) {
    this.quotes = options.quotes ?? new JupiterQuoteService()
    this.orders = options.orders ?? new RWAConditionalOrders()
    this.cached = options.cached ?? assetStore<SavedRWA>('rwaTransactions')
    this.feeReserve = options.feeReserve ?? 10000000
    this.mandate = options.mandate ?? (async () => null)
    this.resolver = options.resolver ?? new AssetResolver(registry)
    this.referencePrices = options.referencePrices ?? new DexScreenerPrices()
  }

  /** Canonical classification. The route uses this instead of any frontend keyword list. */
  classify(text: string): AssetResolution { return this.resolver.resolve(text) }

  /**
   * Category discovery: ranks ALREADY-APPROVED candidates for a category and budget. Identity still
   * comes only from RWA_APPROVED_LIST, so no market signal can add, promote or reject a token here.
   * With no approved candidate for the category, it says so plainly and never invents a token.
   */
  private async discoverCategory(userId: string, owner: string, id: string, text: string,
    category: string | undefined, budget: { amount: number; currency: 'SOL' | 'USDC' } | undefined, specific?: RWAAsset): Promise<RWAReply> {
    const label = category ? `${category.toLowerCase()} ` : ''
    const candidates = specific ? [specific] : filterApprovedByCategory(this.registry.list(), category)
    if (candidates.length === 0) throw new InputError(`No approved ${label}RWA candidates are currently available.`)
    const priced: PricedCandidate[] = []
    for (const asset of candidates) {
      try { this.registry.verifyIdentity(asset, owner || undefined) } catch { continue }
      const candidate: PricedCandidate = { asset, priceUsd: await this.observedPriceUsd(asset) }
      if (asset.mint.includes(':') && budget && candidate.priceUsd) {
        try {
        const usd = budget.currency === 'USDC' ? budget.amount
          : Number((await this.quotes.quote(SOL_MINT, USDC_MINT, String(Math.round(budget.amount * 1e9)))).outAmount) / 1e6
        const quantity = usd / candidate.priceUsd
        if (Number.isFinite(quantity) && quantity > 0) candidate.estimatedQuantity = String(quantity)
        } catch { /* Missing SOL conversion leaves demo budget unconfirmed. */ }
      } else if (budget && !asset.mint.includes(':')) {
        try {
          const amount = String(Math.round(budget.amount * 10 ** (budget.currency === 'SOL' ? SOL_DECIMALS : USDC_DECIMALS)))
          const quote = await this.quotes.quote(budget.currency === 'SOL' ? SOL_MINT : USDC_MINT, asset.mint, amount)
          if (BigInt(quote.outAmount) > 0n) candidate.estimatedQuantity = formatAtomic(quote.outAmount, asset.decimals!)
          candidate.priceImpactPct = quote.priceImpactPct
        } catch { /* Quote failure does not revoke an approved identity; budget fit stays unknown. */ }
      }
      priced.push(candidate)
    }
    const recommendations = rankApprovedCandidates(priced, budget)
    let intent: RWAIntent | undefined
    try { intent = parseRWAIntent(text, this.registry.list()) } catch { intent = undefined }
    const network = candidates.every(asset => asset.mint.includes(':')) ? 'mainnet' : await this.registry.network()
    const listed = recommendations.slice(0, 5).map(item =>
      `${item.symbol} (${item.mint.includes(':') ? item.mint.split(':')[0] + ' · ' : 'solana · '}${item.category}${item.priceUsd === null ? '' : ` ≈ ${item.priceUsd} USD/token`})` +
      (budget ? item.estimatedQuantity
        ? `: ${budget.amount} ${budget.currency} ≈ ${item.estimatedQuantity} ${item.symbol} (chưa gồm phí mạng)`
        : ': chưa có quote hợp lệ để xác nhận số lượng mua theo ngân sách' : '')).join(', ')
    return this.save(userId, owner, { id, status: 'RECOMMENDED', intent, recommendations,
      network: network === 'mainnet' ? 'mainnet' : 'devnet', warnings: [...this.discoveryWarnings(),
        'Tài sản có khóa mạng:địa chỉ dùng giá Dex Screener để ước tính demo, không phải quote swap. Chỉ chi Devnet SOL; không nhận token thật.'],
      message: `Na tìm thấy ${recommendations.length} RWA đã được duyệt${category ? ` cho nhóm ${category}` : ''}: ${listed}. ` +
        (recommendations.length === 1 ? 'Chỉ có một ứng viên phù hợp trong danh sách duyệt, chưa có lựa chọn khác để so sánh. '
          : `Đã xét ${recommendations.length} ứng viên; ${recommendations.filter(item => item.withinBudget).length} có quote theo ngân sách. `) +
        'Xếp hạng theo khả năng lấy quote và tác động giá nếu có, không dùng giá mỗi token thấp để kết luận đáng mua. ' +
        'Đây là thông tin thị trường để tham khảo, không phải lời khuyên đầu tư và không có giao dịch nào được tạo. ' +
        'Danh tính do canonical mint trong RWA_APPROVED_LIST quyết định; thanh khoản, khối lượng và độ phổ biến chỉ dùng để xếp hạng các ứng viên đã được duyệt.' })
  }

  private discoveryWarnings() {
    return ['Ngân sách USDC là trần chi tiêu tham khảo, không phải số lượng token.',
      'Danh tính RWA do canonical mint trong RWA_APPROVED_LIST quyết định; thanh khoản, khối lượng và độ phổ biến chỉ xếp hạng các ứng viên đã được duyệt, không quyết định độ thật.',
      'Giá lấy từ Jupiter mainnet là dữ liệu thị trường; GoBuy chưa có đường thực thi swap nên không có giao dịch nào được tạo.']
  }

  async discover(userId: string, text: string, owner = ''): Promise<RWAReply> {
    const id = randomUUID()
    let intent: RWAIntent | undefined
    try {
      const resolution = this.classify(text)
      if (resolution.assetType === 'NFT') throw new InputError('Yêu cầu này là NFT, không phải RWA.')
      // CATEGORY_DISCOVERY names no specific asset, so it searches the approved list instead of
      // resolving one canonical mint. RWA_APPROVED_LIST still decides every identity returned here.
      if (resolution.reason === 'category_discovery') {
        return await this.discoverCategory(userId, owner, id, text, resolution.category, resolution.budget)
      }
      if (resolution.assetType !== 'RWA' || resolution.blocked || !resolution.approved) {
        const approved = resolution.symbol ? this.registry.bySymbol(resolution.symbol)
          .filter(asset => asset.verified && asset.allowedForSwap) : []
        // An explicit mint that contradicts the canonical mint the approved list endorses for the same
        // symbol is a substitution attempt: refuse it before any price lookup instead of publishing
        // reference prices for a token RWA_APPROVED_LIST never approved.
        if (resolution.mint && approved.length && !approved.some(asset => asset.mint === resolution.mint)) {
          throw new InputError(`Canonical mint không khớp RWA_APPROVED_LIST: ${resolution.symbol} được duyệt với `
            + `${approved.map(asset => asset.mint).join(', ')}, không phải ${resolution.mint}. Na không thay thế bằng token khác và chưa chi SOL.`)
        }
        const matches = resolution.mint ? [] : approved
        if (matches.length > 1) return this.save(userId, owner, { id, status: 'NEEDS_INPUT', warnings: [],
          message: 'Có nhiều deployment được duyệt. Hãy gửi định danh đầy đủ để chọn mạng: ' + matches.map(asset => asset.mint).join(', ') })
        if (resolution.assetType === 'RWA' && (resolution.mint || resolution.symbol)) {
          return await this.unverifiedPrices(userId, owner, id, resolution)
        }
        const symbol = resolution.symbol ?? text.trim().slice(0, 40)
        // An empty list is a missing approval, not a failed check: never imply the asset was judged fake.
        if (resolution.reason === 'registry_empty') {
          throw new InputError('RWA_APPROVED_LIST đang trống nên Na chưa có canonical mint nào để xác minh. ' +
            `Đây là vấn đề dữ liệu duyệt, không phải giá, và cũng không phải "${symbol}" bị kết luận là giả. ` +
            'Quản trị viên cần duyệt đúng canonical mint (lấy từ nguồn issuer/Jupiter đã xác minh) rồi thử lại. Chưa chi SOL.')
        }
        throw new InputError(`Na không xác minh được "${symbol}" trong RWA_APPROVED_LIST bằng đúng canonical mint. ` +
          'Na không đoán, không dùng thanh khoản/khối lượng để đánh giá độ thật, và không chuyển yêu cầu này sang luồng NFT.')
      }
      intent = parseRWAIntent(text, this.registry.list())
      const asset = resolution.approved
      if (asset.mint.includes(':')) {
        this.registry.verifyIdentity(asset, owner || undefined)
        if (intent.condition || intent.quantity) return this.save(userId, owner, { id, intent, asset,
          status: 'NEEDS_INPUT', warnings: [], message: 'Demo đa blockchain hiện hỗ trợ ngân sách SOL/USDC; chưa hỗ trợ lệnh điều kiện hoặc số lượng token.' })
        const result = await this.discoverCategory(userId, owner, id, text, undefined,
          intent.amount ? { amount: Number(intent.amount) / 10 ** (intent.currency === 'SOL' ? 9 : 6), currency: intent.currency } : undefined, asset)
        return result
      }
      // No wallet is needed to identify an asset or read market data; the mandate is the policy
      // layer, and it is re-read at execution time in revalidate().
      if (!intent.amount && !intent.quantity && !intent.condition) {
        return this.save(userId, owner, { id, intent, asset, status: 'NEEDS_INPUT', warnings: [],
          message: `Đã xác minh ${asset.symbol} theo canonical mint. Bạn muốn chi bao nhiêu USDC/SOL, mua bao nhiêu ${asset.symbol}, hoặc đặt điều kiện giá nào?` })
      }
      const network = await this.registry.network()
      // Identity is verified on chain, so an unapproved mint is refused before any market data.
      await this.registry.verify(asset, owner || undefined)
      if (intent.condition) {
        // A stored order is bound to an owner wallet, so this is the one place a wallet is required.
        if (!owner) throw new InputError('Cần kết nối ví chủ mandate để lưu lệnh RWA có điều kiện. Chưa tạo giao dịch nào.')
        const { order } = await this.orders.create({ userId, owner, asset, intent, mandate: null })
        // The owner must reach the policy re-check, or an eligible order would look like a missing mandate.
        const evaluated = await this.applyPriceGate(userId, order, asset, network, owner)
        return this.save(userId, owner, { ...this.replyFor(order, asset, intent, network), order: evaluated })
      }
      if (network !== 'mainnet') {
        if (!owner) throw new InputError('Cần kết nối ví chủ mandate để lưu lệnh RWA. Chưa tạo giao dịch nào.')
        const { order } = await this.orders.create({ userId, owner, asset, intent, mandate: null })
        return this.save(userId, owner, { ...this.replyFor(order, asset, intent, network), order })
      }
      // A quote that fails verification (substituted mint, wrong amount, expired) must reject
      // outright instead of being reported as a missing route.
      const market = await this.quotePlan(intent, asset)
      return this.save(userId, owner, { id, intent, asset, status: market ? 'QUOTED' : 'EXECUTION_UNAVAILABLE',
        network, quote: market?.plan, warnings: this.standardWarnings(),
        message: market
          ? `${market.verdict} Đây là thông tin thị trường: GoBuy chưa có đường thực thi swap từ Vault, nên không có giao dịch nào được tạo và không có chữ ký nào được yêu cầu.`
          : 'RWA đã được xác minh theo canonical mint nhưng chưa lấy được route thị trường. Chưa tạo giao dịch.' })
    } catch (error) {
      return this.save(userId, owner, { id, intent, status: 'REJECTED', warnings: [],
        message: error instanceof InputError ? error.message : 'Không xác minh được dữ liệu RWA. Chưa tạo giao dịch.' })
    }
  }

  async status(userId: string, id: string, owner = ''): Promise<RWAReply> {
    const saved = await this.cached.get(userId, id)
    if (!saved) throw new InputError('Không tìm thấy yêu cầu RWA của tài khoản này.')
    const order = saved.reply.order
    if (!order || isTerminalStatus(order.status)) return saved.reply
    const asset = saved.reply.asset
    if (!asset) return saved.reply
    const network = await this.registry.network()
    const evaluated = await this.applyPriceGate(userId, order, asset, network, owner)
    return this.save(userId, saved.owner, { ...this.replyFor(evaluated, asset, saved.intent, network), order: evaluated })
  }

  async list(userId: string): Promise<RWAOrder[]> { return this.orders.list(userId) }

  private async unverifiedPrices(userId: string, owner: string, id: string, resolution: AssetResolution): Promise<RWAReply> {
    const warning = 'Chưa được duyệt trong RWA_APPROVED_LIST; chưa xác minh là RWA chính thức. Chỉ tham khảo giá, không tạo lệnh, không mua và không chi SOL.'
    try {
      const rows = await this.referencePrices.lookup({ mint: resolution.mint, symbol: resolution.symbol })
      const mints = new Set(rows.map(row => row.chain + ':' + row.mint))
      return this.save(userId, owner, { id, status: 'NEEDS_INPUT', warnings: [warning], referencePrices: rows.slice(0, 10),
        message: warning + '\n' + (rows.length
          ? `Tìm thấy ${mints.size} token khớp tên/địa chỉ trên Dex Screener. Giá USD và link tham khảo nằm bên dưới; đọc lúc ${new Date().toISOString()}.`
            + (mints.size > 1 ? '\nCó nhiều mint trùng tên. Hãy gửi mint cụ thể để tra giá; Na chưa chọn token nào.' : '')
            + (rows.length > 10 ? '\nChỉ hiển thị 10 pool đầu; hãy cung cấp mint cụ thể để thu hẹp kết quả.' : '')
          : 'Dex Screener chưa trả về cặp giao dịch khớp chính xác. Bạn có thể gửi tên/symbol hoặc mint Solana cụ thể.') })
    } catch {
      return this.save(userId, owner, { id, status: 'NEEDS_INPUT', warnings: [warning],
        message: warning + '\nHiện chưa lấy được giá tham khảo từ Dex Screener. Vui lòng thử lại sau.' })
    }
  }

  /** Re-checks the price condition and, when satisfied, revalidates policy before any execution. */
  private async applyPriceGate(userId: string, order: RWAOrder, asset: RWAAsset, network: 'mainnet' | 'devnet' | 'unknown', owner = ''): Promise<RWAOrder> {
    if (isTerminalStatus(order.status)) return order
    if (this.orders.expired(order)) return this.orders.update(userId, order, { status: 'EXPIRED' })
    const observed = network === 'mainnet' ? await this.observedPriceUsd(asset) : null
    const observation = { observedPrice: observed, observedAt: observed === null ? null : new Date().toISOString() }
    const met = this.orders.conditionMet(order, observed)
    if (met === null) {
      return this.orders.update(userId, order, { observation, execution: { network: network === 'mainnet' ? 'mainnet' : 'devnet',
        reason: 'DEVNET_EXECUTION_UNAVAILABLE: chưa có dữ liệu giá mainnet để đối chiếu điều kiện. Không tạo giao dịch.', signature: null },
        status: 'EXECUTION_UNAVAILABLE' })
    }
    if (!met) return this.orders.update(userId, order, { observation, status: 'WAITING_FOR_PRICE' })
    // Eligible: revalidate everything immediately before any execution attempt.
    const executing = await this.orders.update(userId, order, { observation, status: 'EXECUTING' })
    const blocked = await this.revalidate(executing, asset, owner)
    return this.orders.update(userId, executing, { execution: { network: 'mainnet', reason: blocked, signature: null },
      status: blocked.startsWith('DEVNET') ? 'EXECUTION_UNAVAILABLE' : 'EXECUTION_UNAVAILABLE' })
  }

  /** Every gate that must pass immediately before spending. Returns the blocking reason, or the CPI gap. */
  private async revalidate(order: RWAOrder, asset: RWAAsset, owner: string): Promise<string> {
    if (!this.registry.isApprovedMint(order.assetMint)) return 'BLOCKED: mint không còn nằm trong RWA_APPROVED_LIST.'
    try { await this.registry.verify(asset, owner || undefined) }
    catch (error) { return 'BLOCKED: ' + (error instanceof Error ? error.message : 'registry verification failed') }
    const mandate = owner ? await this.mandate(owner) : null
    if (!mandate) return 'BLOCKED: chưa đọc được mandate của ví chủ.'
    if (!mandate.active) return 'BLOCKED: mandate không còn ACTIVE.'
    if (mandate.allowedCategory !== 'RWA' && mandate.allowedCategory !== 'ANY') return 'BLOCKED: mandate này được ký cho NFT, không được chi cho RWA.'
    const ceiling = BigInt(order.maxTotalSpend ?? order.spendAmount ?? '0')
    if (order.maxSpendCurrency === 'SOL' || order.spendCurrency === 'SOL') {
      if (ceiling > mandate.remainingLamports) return 'BLOCKED: hạn mức còn lại không đủ cho trần chi tiêu.'
    }
    // The controlled Vault has no CPI into Jupiter, so there is no safe execution path from it.
    return 'ANCHOR_JUPITER_EXECUTION_REQUIRED: Na Vault chỉ chuyển SOL theo policy; chưa có CPI sang Jupiter, ' +
      'nên không thể hoán đổi sang RWA từ vault mà không chuyển tiền sang ví Agent. Không thực thi.'
  }

  private replyFor(order: RWAOrder, asset: RWAAsset, intent: RWAIntent, network: 'mainnet' | 'devnet' | 'unknown'): RWAReply {
    const detail = order.orderType === 'QUANTITY'
      ? `Mua ${formatAtomic(order.quantity ?? '0', asset.decimals!)} ${asset.symbol}, trần tổng chi ` +
        `${order.maxTotalSpend ? formatAtomic(order.maxTotalSpend, SOL_DECIMALS) : '?'} ${order.maxSpendCurrency ?? ''}`
      : `Chi ${order.spendAmount ? formatAtomic(order.spendAmount, order.spendCurrency === 'SOL' ? SOL_DECIMALS : USDC_DECIMALS) : '?'} ${order.spendCurrency ?? ''} để mua ${asset.symbol}`
    const condition = order.condition
      ? ` · Điều kiện: ${asset.symbol} < ${order.condition.targetPrice} ${order.condition.priceCurrency}`
      : ''
    const observed = order.observation?.observedPrice
    const price = observed === null || observed === undefined ? '' : ` · Giá hiện tại: ${observed} ${order.condition?.priceCurrency ?? 'USD'}`
    const status = order.status === 'WAITING_FOR_PRICE' ? 'Đang chờ giá'
      : order.status === 'EXECUTING' ? 'Điều kiện giá đã đạt. Na đang xác minh policy và execution quote.'
        : order.status === 'EXECUTION_UNAVAILABLE' ? 'RWA đã được xác minh nhưng giao dịch này chưa có route thực thi trên Devnet.'
          : order.status
    return { id: order.id, status: order.status, intent, asset, order,
      network: network === 'mainnet' ? 'mainnet' : 'devnet', warnings: this.standardWarnings(),
      message: `${detail}${condition}${price} · Trạng thái: ${status}.` }
  }

  private standardWarnings() {
    return ['USDC/USD trong yêu cầu là số tiền chi, không phải số lượng RWA.',
      'Danh tính RWA được quyết định bởi canonical mint trong RWA_APPROVED_LIST, không dùng thanh khoản, khối lượng hay độ phổ biến.',
      'RWA dùng Solana mainnet và tiền thật. GoBuy chưa có đường thực thi swap từ Vault; không có giao dịch nào được tạo.']
  }

  /** 1 USDC buys `units` of the asset, so the unit price in USD is 1/units. Market data only. */
  private async observedPriceUsd(asset: RWAAsset): Promise<number | null> {
    try {
      if (asset.mint.includes(':')) {
        const rows = await this.referencePrices.lookup({ mint: asset.mint })
        const [chain, address] = asset.mint.split(':')
        const prices = rows.filter(row => row.chain === chain && row.mint.toLowerCase() === address && row.priceUsd !== null)
          .map(row => row.priceUsd!).sort((a, b) => a - b)
        return prices.length ? prices[Math.floor(prices.length / 2)] : null
      }
      const quote = await this.quotes.quote(USDC_MINT, asset.mint, '1000000')
      const units = Number(quote.outAmount) / 10 ** asset.decimals!
      if (!Number.isFinite(units) || units <= 0) return null
      return Number((1 / units).toFixed(6))
    } catch { return null }
  }

  /**
   * Market plan for the order. The two order types ask different questions, so they quote in opposite
   * directions: a SPEND order prices its money into the asset, while a QUANTITY order values the exact
   * units it wants so the ceiling is compared against a real cost instead of an unrelated SOL spend.
   */
  private async quotePlan(intent: RWAIntent, asset: RWAAsset): Promise<{ plan: RWAReply['quote']; verdict: string } | undefined> {
    const expiresAt = new Date(Date.now() + 20000).toISOString()
    if (intent.order === 'QUANTITY' && intent.quantity) {
      const units = quantityUnits(intent.quantity, asset.decimals!)
      const quote = await this.quotes.quote(asset.mint, USDC_MINT, units)
      const policyValueLamports = await this.quotes.policyValue(USDC_MINT, quote.outAmount, this.feeReserve)
      const cost = (Number(quote.outAmount) / 10 ** USDC_DECIMALS).toFixed(2)
      const ceiling = intent.maxSpendCurrency === 'SOL' && intent.maxTotalSpend ? BigInt(intent.maxTotalSpend) : undefined
      const ceilingText = intent.maxTotalSpend ? formatAtomic(intent.maxTotalSpend, SOL_DECIMALS) : '?'
      const verdict = `${intent.quantity} ${asset.symbol} ≈ ${cost} USDC theo route hiện tại` + (ceiling === undefined ? '.'
        : BigInt(policyValueLamports) <= ceiling ? `, nằm trong trần ${ceilingText} SOL.`
          : `, VƯỢT trần ${ceilingText} SOL nên Na không thực thi.`)
      return { verdict, plan: { inputMint: asset.mint, outputMint: USDC_MINT, inAmount: quote.inAmount, outAmount: quote.outAmount,
        minOutput: quote.otherAmountThreshold, slippageBps: quote.slippageBps, expiresAt, policyValueLamports,
        network: 'mainnet' as const, route: quote.routePlan.map(step => step.swapInfo.label ?? 'Jupiter') } }
    }
    const amount = intent.amount
    if (!amount) return undefined
    const inputMint = intent.currency === 'SOL' ? SOL_MINT : USDC_MINT
    const quote = await this.quotes.quote(inputMint, asset.mint, amount)
    const spendText = formatAtomic(amount, inputMint === SOL_MINT ? SOL_DECIMALS : USDC_DECIMALS)
    return { verdict: `Chi ${spendText} ${intent.currency ?? 'USDC'} nhận tối đa ${formatAtomic(quote.outAmount, asset.decimals!)} ${asset.symbol} theo route hiện tại.`,
      plan: { inputMint, outputMint: asset.mint, inAmount: quote.inAmount, outAmount: quote.outAmount,
        minOutput: quote.otherAmountThreshold, slippageBps: quote.slippageBps, expiresAt,
        policyValueLamports: await this.quotes.policyValue(inputMint, amount, this.feeReserve),
        network: 'mainnet' as const, route: quote.routePlan.map(step => step.swapInfo.label ?? 'Jupiter') } }
  }

  private async save(userId: string, owner: string, reply: RWAReply): Promise<RWAReply> {
    const parsedIntent = reply.intent ?? parseRWAIntent('rwa', this.registry.list())
    await this.cached.put(userId, reply.id, { reply, intent: parsedIntent, owner: reply.order?.owner || owner }, true)
    return reply
  }
}
