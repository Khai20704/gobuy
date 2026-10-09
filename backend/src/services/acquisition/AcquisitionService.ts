import { NFTPurchaseError } from '../../nft/errors.js'
import { randomUUID } from 'node:crypto'
import { autonomousNFTCandidateSchema, namedNFTPurchaseName, type DiscoveryReply, type NFTCandidate } from '@gobuy/shared'
import { assetStore, type AssetStore } from '../../persistence/AssetStore.js'
import { InputError } from '../../schemas/search.js'
import { DiscoveryEngine, NFTIntentParser, acquisitionLog } from './discovery.js'
import { DevnetSimulationExecutor, type ExecutionEngine } from './ExecutionEngine.js'
import { WalletAssociationService } from './WalletAssociationService.js'
import { PortfolioService } from './PortfolioService.js'
import { simulationMetadataId } from '../nftDemo/NftDemoService.js'
import { resolveConversationInput, type NaConversationState } from './NaConversationContext.js'
import { NFTRankingService } from '../nft-intelligence/NFTRankingService.js'
import { InvestmentTwinService } from '../twin/InvestmentTwinService.js'
import { NaChatService } from './NaChatService.js'
import { AutonomousPurchaseService } from './AutonomousPurchaseService.js'
import { AutonomousSpendBlockedError } from './AutonomousSpendBlockedError.js'
import type { AutonomousReconciliation } from '@gobuy/shared'
import { budgetExpression, normalizeIntentText } from './intentLanguage.js'
import { deliveryService } from '../delivery/delivery.js'
import type { AutonomousPurchaseResult } from '@gobuy/shared'
import type { DeliveryService } from '../delivery/DeliveryService.js'

export type AcquisitionRecord = { id: string; owner: string; candidate: NFTCandidate; maximumLamports: number }
type SavedDiscovery = { reply: DiscoveryReply; text: string }
export class AcquisitionService {
  readonly portfolio: PortfolioService
  constructor(readonly discovery: DiscoveryEngine, private readonly parser: NFTIntentParser,
    readonly wallets = new WalletAssociationService(), private readonly executor: ExecutionEngine = new DevnetSimulationExecutor(),
    private readonly discoveries: AssetStore<SavedDiscovery> = assetStore('assetDiscoveries'),
    private readonly acquisitions: AssetStore<AcquisitionRecord> = assetStore('assetAcquisitions'),
    private readonly metadata: AssetStore<NFTCandidate> = assetStore('assetMetadata'), portfolio?: PortfolioService,
    private readonly conversations: AssetStore<NaConversationState> = assetStore('naConversations'),
    private readonly intelligence = new NFTRankingService(), private readonly investmentTwin = new InvestmentTwinService(),
    private readonly assistant = new NaChatService(), readonly autonomous = new AutonomousPurchaseService(),
    private readonly deliveries: Pick<DeliveryService, 'deliver'> & Partial<Pick<DeliveryService, 'getPlan' | 'list'>> = {
      deliver: (user, input) => deliveryService().enqueue(user, input),
      getPlan: (user, id) => deliveryService().getPlan(user, id), list: user => deliveryService().list(user),
    }) {
    this.portfolio = portfolio ?? new PortfolioService(executor)
  }

  async chat(userId: string, text: string, conversationId?: string) {
    const context = conversationId ? await this.conversations.get(userId, conversationId) : undefined
    return this.assistant.reply(userId, text, conversationId, context)
  }
  async resumeConversation(userId: string, request: { id: string; conversationId?: string; prompt: string; response?: string }) {
    const conversationId = request.conversationId ?? request.id
    await this.assistant.restore(userId, conversationId, request.prompt, request.response)
    const existing = await this.conversations.get(userId, conversationId)
    const saved = await this.discoveries.get(userId, request.id)
    if (!existing && saved) await this.conversations.put(userId, conversationId, {
      currentPrompt: saved.text, currentIntent: { ...saved.reply.intent, action: 'SEARCH' },
      selectedCandidate: saved.reply.candidates[0], previousMints: [],
      messages: [{ role: 'user', text: request.prompt }, { role: 'na', text: request.response ?? saved.reply.message }],
    })
    return { conversationId, discovery: saved?.reply }
  }
  async discover(userId: string, text: string, id: string = randomUUID(), conversationId?: string, owner?: string): Promise<DiscoveryReply> {
    const previous = await this.discoveries.get(userId, id)
    if (previous) {
      if (previous.text !== text) throw new InputError('Mã yêu cầu đã dùng cho nội dung khác.')
      return { ...previous.reply, status: previous.reply.status ?? (previous.reply.candidates.length ? 'MATCHED' : 'NO_MATCH'),
        sources: previous.reply.sources ?? [] }
    }
    const context = conversationId ? await this.conversations.get(userId, conversationId) : undefined
    let discoveryText = text
    if (namedNFTPurchaseName(text) && ![...normalizeIntentText(text).matchAll(budgetExpression)].length) {
      if (!owner) throw new InputError('Connect the mandate owner or specify an explicit SOL budget.')
      await this.wallets.require(userId, owner)
      const maximum = await this.autonomous.budgetForNamedPurchase(owner)
      // A server-read mandate supplies the ceiling; never infer spending authority from a name.
      const ceiling = maximum > 10_000_000_000n ? 10_000_000_000n : maximum
      discoveryText = `${text} max ${ceiling / 1_000_000_000n}.${(ceiling % 1_000_000_000n).toString().padStart(9, '0')} SOL`
    }
    const resolved = await resolveConversationInput(discoveryText, context, this.parser)
    if ('error' in resolved) throw new InputError(resolved.error)
    let intent = resolved.intent
    try { intent = await this.investmentTwin.apply(userId, intent, text) } catch { acquisitionLog('investment_twin', { outcome: 'unavailable' }) }
    const research = intent.requestKind === 'investment_research'
    const result = research && !intent.collectionQuery && !intent.collectionAddress && !intent.collectionSymbol
      ? await this.intelligence.search(intent, this.discovery.providers) : await this.discovery.search(intent)
    const selectedCandidate = result.candidates[0]
    const rarityCaveat = intent.priorities.includes('rarity') && selectedCandidate?.rarityScore == null
      ? 'Marketplace không cung cấp rarity rank đáng tin, nên Na không thể xác nhận NFT này là hiếm nhất; Na chọn theo các tín hiệu còn xác minh được. '
      : ''
    const mainnetResearch = 'research' in result ? result.research : undefined
    const message = mainnetResearch
      ? result.status === 'COLLECTION_UNRESOLVED'
        ? 'Na chưa xác định đáng tin cậy được collection này. Bạn có thể cung cấp địa chỉ collection trên Solana. Điều này không có nghĩa collection không tồn tại. Chưa tạo giao dịch.'
        : result.status === 'NO_ASSETS_FOUND'
          ? 'Đã xác định collection trên Mainnet nhưng trang dữ liệu Helius được kiểm tra chưa có NFT. MAINNET · Chỉ nghiên cứu, không mua được. Chưa tạo giao dịch.'
          : `Đã kiểm tra ${mainnetResearch.assetsChecked} NFT trong collection ${mainnetResearch.collection} trên Solana Mainnet. ${result.status === 'INSUFFICIENT_MARKET_DATA' ? 'Chưa có giá listing hoặc dữ liệu thị trường để kết luận NFT rẻ nhất, đắt nhất hay đáng mua. ' : ''}Các NFT hiển thị được sắp theo độ khớp metadata, không phải xếp hạng đầu tư. MAINNET · Chỉ nghiên cứu, không mua được. Chưa tạo giao dịch.`
      : result.status === 'PROVIDER_UNAVAILABLE'
        ? 'Nguồn dữ liệu nghiên cứu NFT hiện không khả dụng. Chưa thể xác minh collection hoặc giá; không có nghĩa collection không tồn tại. Chưa tạo giao dịch.'
      : selectedCandidate?.sourceNetwork === 'mainnet'
      ? `MAINNET · Chỉ xem, không mua được. ${selectedCandidate.name} có giá niêm yết ${Number(selectedCandidate.listing.priceLamports) / 1e9} SOL, ${intent.objective === 'HIGHEST_PRICE' ? 'cao nhất' : 'thấp nhất'} trong kết quả Tensor đã kiểm tra. Đây không phải tổng chi giao dịch hoặc đánh giá giá trị đầu tư. Không dùng policy hay SOL Devnet để mua NFT này.`
      : intent.priceDiscoveryOnly && selectedCandidate
        ? `Giá listing thấp nhất trong dữ liệu đã kiểm tra là ${Number(selectedCandidate.listing.priceLamports) / 1e9} SOL, chưa gồm phí. Chưa có mức chi được cho phép; Na chưa tạo giao dịch. Hãy xác nhận mức tối đa bằng SOL trước khi kiểm tra mua.`
      : result.status === 'NO_SAFE_PURCHASE'
      ? 'Có listing phù hợp với điều kiện cơ bản, nhưng chưa có ứng viên đạt ngưỡng dữ liệu, độ tin cậy và rủi ro để mua tự động. Chưa tạo giao dịch.'
      : result.status === 'COLLECTION_NOT_FOUND'
      ? `Không tìm thấy collection “${intent.collectionQuery ?? intent.collectionSymbol ?? ''}” trong phạm vi tra cứu Tensor Devnet. Na không tự thay bằng collection khác và chưa tạo giao dịch.`
      : result.status === 'COLLECTION_AMBIGUOUS'
        ? `Có nhiều collection trùng với “${intent.collectionQuery ?? ''}”. Chưa thể xác định đúng collection nên Na chưa tìm listing hoặc tạo giao dịch.`
      : research
      ? selectedCandidate && 'intelligence' in result && result.intelligence
        ? `Na chọn ${selectedCandidate.name} theo tín hiệu thị trường đã kiểm tra. ${result.intelligence.explanation} Chỉ thực hiện mua sau khi được cho phép.`
        : result.status === 'DATA_UNAVAILABLE'
          ? 'Không thể xếp hạng đáng tin cậy vì dữ liệu thị trường hiện không khả dụng từ các provider đã cấu hình. Chưa tạo giao dịch.'
          : result.status === 'INSUFFICIENT_DATA'
            ? 'Marketplace có dữ liệu listing, nhưng chưa đủ tín hiệu thanh khoản/lịch sử để xếp hạng đáng tin cậy. Chưa tạo giao dịch.'
            : 'Không tìm thấy listing phù hợp trong phạm vi dữ liệu marketplace đã kiểm tra. Điều này không có nghĩa NFT đó không tồn tại. Chưa tạo giao dịch.'
      : selectedCandidate ? intent.action === 'BUY'
      ? selectedCandidate.provider === 'tensor'
        ? `${rarityCaveat}Na đã chọn listing Tensor Devnet và xác minh NFT qua Helius. Đang kiểm tra listing và mandate để thực hiện Devnet autonomous spend demo bằng Na Agent. Đây chưa phải mua NFT hoàn chỉnh và không xác nhận giá trị đầu tư.`
        : `${rarityCaveat}PURCHASE yêu cầu listing Tensor Devnet hợp lệ và mandate ACTIVE. Không dùng Phantom làm phương án thay thế khi thực thi bị chặn.`
      : `${rarityCaveat}Na đã chọn một NFT phù hợp nhất trong dữ liệu đã kiểm tra. Đây là đề xuất duy nhất; bạn có thể yêu cầu Na tìm lựa chọn khác.`
      : intent.excludedMints.length ? 'Không tìm thấy lựa chọn khác đủ điều kiện trong ngân sách và dữ liệu đã kiểm tra. Chưa tạo giao dịch.'
        : result.status === 'DATA_UNAVAILABLE'
          ? result.sources.some(source => source.provider === 'tensor-mainnet-readonly' && 'code' in source && source.code === 'AUTH_REQUIRED')
            ? `Chưa thể tra cứu giá NFT${intent.collectionQuery ? ` trong collection “${intent.collectionQuery}”` : ''} trên Mainnet vì backend chưa có Tensor API key. Cần cấu hình TENSOR_API_KEY trong backend/.env và khởi động lại backend trước khi nhắn “thử lại”. Helius API key không thay thế Tensor API key. Khi có kết quả Mainnet, Na chỉ hiển thị giá, không cho phép mua. Chưa tạo giao dịch.`
          : `Na đã hiểu yêu cầu tìm NFT${intent.collectionQuery ? ` trong collection “${intent.collectionQuery}”` : ''}${intent.priceDiscoveryOnly ? ' để tra cứu giá' : ' theo ngân sách của bạn'}. ${result.sources.some(source => 'code' in source && source.code === 'RATE_LIMITED')
            ? 'Marketplace đang giới hạn lượt truy cập; bạn có thể nhắn “thử lại” sau một lát.'
            : 'Hiện chưa kết nối được dữ liệu marketplace để xác minh giá và listing. Bạn có thể nhắn “thử lại”; không cần nhập lại yêu cầu.'} Chưa tạo giao dịch.`
          : result.status === 'INSUFFICIENT_DATA'
            ? 'Có listing trong ngân sách, nhưng chưa đủ dữ liệu để chọn theo tiêu chí của bạn. Bạn có thể đổi sang giá thấp nhất hoặc chỉ rõ collection. Chưa tạo giao dịch.'
            : `Chưa tìm thấy listing phù hợp${intent.collectionQuery ? ` trong collection “${intent.collectionQuery}”` : ''}${intent.priceDiscoveryOnly ? '' : ' với ngân sách'} trong phạm vi đã kiểm tra. Không có nghĩa collection không tồn tại. Chưa tạo giao dịch.`
    // The window must outlast the time a user needs to read Na's answer; the listing is re-verified before execution.
    const reply: DiscoveryReply = { id, intent, ...result, expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      message,
      warnings: research ? [...result.warnings, 'Phạm vi dữ liệu có giới hạn; không phải toàn bộ NFT trên Solana.'] : [...result.warnings, 'Phạm vi tìm kiếm có giới hạn; không phải toàn bộ NFT trên Solana.',
        ...(intent.parser === 'literal' && intent.parserStatus !== 'ready' && !intent.broadSearch ? [intent.parserStatus === 'not_configured'
          ? 'Na đang dùng bộ nhận diện cơ bản; một số cách diễn đạt hoặc chủ đề có thể chưa được hiểu đúng.'
          : 'AI đang tạm gián đoạn; Na dùng bộ nhận diện dự phòng và giữ nguyên ngân sách bạn đã nêu.'] : [])],
    }
    await this.discoveries.put(userId, id, { text, reply }, true)
    if (conversationId) {
      const messages = [...(context?.messages ?? []), { role: 'user' as const, text }, { role: 'na' as const, text: message }].slice(-20)
      await this.conversations.put(userId, conversationId, {
        currentPrompt: resolved.contextual ? context!.currentPrompt : resolved.prompt,
        currentIntent: intent,
        selectedCandidate,
        previousMints: resolved.previousMints,
        messages,
      })
    }
    return reply
  }
  private async refresh(candidate: NFTCandidate) {
    const provider = this.discovery.providers.find(p => p.name === candidate.provider)
    if (!provider) throw new InputError('Nguồn marketplace không còn được cấu hình. Tìm kiếm lại.')
    let current: NFTCandidate | undefined
    try { current = await provider.refresh(candidate, AbortSignal.timeout(10000)) }
    catch { throw new InputError('Không xác minh lại được listing. Chưa gửi giao dịch; tìm kiếm lại sau.') }
    if (!current) throw new NFTPurchaseError('LISTING_UNAVAILABLE')
    if (current.listing.priceLamports !== candidate.listing.priceLamports) throw new NFTPurchaseError('PRICE_CHANGED')
    if (current.mint !== candidate.mint || current.sourceNetwork !== candidate.sourceNetwork
      || current.listing.seller !== candidate.listing.seller || current.listing.priceLamports !== candidate.listing.priceLamports) {
      throw new NFTPurchaseError('LISTING_CHANGED')
    }
    return current
  }
  async autonomousPurchase(userId: string, discoveryId: string, candidateId: string, owner: string, demoAccepted = false) {
    let executionMayHaveStarted = false
    try {
    // An authenticated app session alone cannot spend somebody else's mandate.
    await this.wallets.require(userId, owner)
    const prior = await this.autonomous.existing(userId, discoveryId)
    if (prior) {
      executionMayHaveStarted = true
      if (prior.owner !== owner || prior.reply.selected.id !== candidateId) throw new InputError('Yêu cầu đã gắn với ví/listing khác.')
      return this.deliverPurchase(userId, owner, await this.autonomous.status(userId, discoveryId))
    }
    const saved = await this.discoveries.get(userId, discoveryId)
    if (!saved || Date.parse(saved.reply.expiresAt) <= Date.now()) throw new InputError('Discovery expired or does not belong to this account.')
      if (saved.reply.intent.action !== 'BUY' || saved.reply.intent.priceDiscoveryOnly) throw new InputError('SEARCH has no spending authority. Send an explicit PURCHASE request with a budget.')
      if (!demoAccepted) throw new InputError('Xác nhận NFT GoBuy DEMO trong phần thiết lập ngân sách trước khi mua. Chưa chi SOL.')
    const candidate = saved.reply.candidates.find(item => item.id === candidateId)
    const parsed = autonomousNFTCandidateSchema.safeParse(candidate)
    if (!parsed.success) throw new InputError('Invalid execution listing: ' + parsed.error.issues.map(issue => issue.path.join('.') + ': ' + issue.message).join('; '))
    const fresh = await this.refresh(parsed.data)
    if (fresh.marketplaceListing?.listingId !== parsed.data.marketplaceListing.listingId) throw new InputError('Listing identity changed. Execution blocked.')
    executionMayHaveStarted = true
    return this.deliverPurchase(userId, owner, await this.autonomous.execute(userId, discoveryId, owner, fresh, BigInt(saved.reply.intent.maximumLamports),
      { recipientWallet: owner, verifiedAt: new Date().toISOString() }))
    } catch (error) {
      if (!executionMayHaveStarted && (error instanceof InputError || error instanceof NFTPurchaseError)) throw new AutonomousSpendBlockedError(error.message)
      throw error
    }
  }
  async reconcilePurchase(userId: string, id: string, owner?: string, readOnly = false): Promise<AutonomousReconciliation> {
    try {
      const order = await this.autonomous.existing(userId, id)
      if (readOnly) {
        if (!order) return { id, status: 'PENDING', safeToRetry: false, message: 'Đang chờ lưu trạng thái đơn.' }
        const delivery = (await deliveryService().list(userId)).find(row => row.kind === 'NFT' && row.id === id)
        const payment = order.reply
        const phase = delivery?.phase ?? (payment.result.status === 'CONFIRMED' ? 'PAYMENT_CONFIRMED' : 'PAYMENT_PENDING')
        const status = delivery?.phase === 'COMPLETED' ? 'CONFIRMED' as const : 'PENDING' as const
        const message = delivery?.message ?? 'Đang chờ xác nhận thanh toán hoặc kế hoạch giao tài sản. Không thanh toán lại.'
        return { id, status, message, safeToRetry: false, purchase: { ...payment, phase, delivery,
          result: { ...payment.result, status, message } } }
      }
      if (!order && !owner) return { id, status: 'RECONCILIATION_ERROR', message: 'Connect the mandate owner to reconcile this request.', safeToRetry: false }
      const address = order?.owner ?? owner!
      await this.wallets.require(userId, address)
      const saved = !order ? await this.discoveries.get(userId, id) : undefined
      if (!order && (!saved || saved.reply.intent.action !== 'BUY' || !saved.reply.candidates[0])) {
        // Nothing executable was ever prepared for this id. A mandate that has spent nothing proves no
        // submission happened, so the client may clear the pending marker and create a new BUY request.
        const neverSubmitted = await this.autonomous.spentLamports(address) === 0n
        return { id, status: neverSubmitted ? 'NOT_SUBMITTED' : 'RECONCILIATION_ERROR', safeToRetry: neverSubmitted,
          message: neverSubmitted
            ? 'Yêu cầu này chưa từng gửi khoản chi nào (mandate chưa chi SOL). Bạn có thể tạo yêu cầu mua mới.'
            : 'No account-owned BUY discovery exists for this request ID, and the mandate has spending. Do not submit another BUY.' }
      }
      if (!order && Date.parse(saved!.reply.expiresAt) > Date.now()) return { id, status: 'PENDING', message: 'Request may still be preparing. No automatic resubmission.', safeToRetry: false }
      const payment = order ? await this.autonomous.status(userId, id)
        : await this.autonomous.recoverMissing(userId, id, address, saved!.reply.candidates[0], saved!.reply.expiresAt)
      const purchase = await this.deliverPurchase(userId, address, payment)
      const safeToRetry = (purchase.result.status === 'NOT_SUBMITTED' || purchase.result.status === 'FAILED')
        && purchase.result.mandate?.spentLamports === '0'
      return { id, status: purchase.result.status, message: purchase.result.message, safeToRetry, purchase }
    } catch (error) {
      return { id, status: 'RECONCILIATION_ERROR', message: error instanceof InputError ? error.message : 'Cannot verify chain/database state. Retry BUY remains blocked.', safeToRetry: false }
    }
  }
  private async deliverPurchase(userId: string, owner: string, payment: AutonomousPurchaseResult): Promise<AutonomousPurchaseResult> {
    if (payment.result.status !== 'CONFIRMED') return { ...payment, phase: 'PAYMENT_PENDING' }
    if (!payment.result.signature) return { ...payment, phase: 'PAYMENT_CONFIRMED',
      result: { ...payment.result, status: 'PENDING', message: 'Đã xác nhận khoản chi; đang truy tìm chữ ký thanh toán trước khi cấp tài sản.' } }
    const selected = payment.selected
    const order = await this.autonomous.existing(userId, payment.id)
    const plan = await this.deliveries.getPlan?.(userId, payment.id)
    if (!order || order.owner !== owner) throw new InputError('Order recipient mismatch.')
    if (plan && plan.mode !== 'DEVNET_DEMO_MINT' || !plan && order.deliveryMode !== 'DEVNET_DEMO_MINT') {
      const delivery = (await this.deliveries.list?.(userId))?.find(row => row.kind === 'NFT' && row.id === payment.id)
      return { ...payment, phase: delivery?.phase ?? 'PAYMENT_CONFIRMED', delivery,
        result: { ...payment.result, status: delivery?.phase === 'COMPLETED' ? 'CONFIRMED' : 'PENDING',
          message: delivery?.phase === 'COMPLETED' ? delivery.message : 'Đã thanh toán. Đơn cũ cần xác minh ví và đồng ý nhận NFT demo thay thế; không thanh toán lại.' } }
    }
    if (plan && (plan.owner !== owner || plan.paymentSignature !== payment.result.signature)) throw new InputError('Delivery identity mismatch.')
    const { metadataId: _, ...storedInput } = plan ?? { metadataId: '' }
    const delivery = await this.deliveries.deliver(userId, plan ? storedInput as import('../delivery/DeliveryService.js').DeliveryInput : {
      id: payment.id, owner, kind: 'NFT', name: selected.name, sourceMint: selected.mint,
      ...(order.assetStandard ? { assetStandard: order.assetStandard, metadataUri: order.metadataUri, imageUri: order.imageUri } : {}), mode: 'DEVNET_DEMO_MINT', rawQuantity: '1', decimals: 0, paymentSignature: payment.result.signature,
      recipientWallet: order.recipientWallet, recipientVerifiedAt: order.recipientVerifiedAt,
      paymentLamports: payment.actualSpendLamports ?? payment.requestedSpendLamports,
    })
    return { ...payment, phase: delivery.phase, delivery, result: { ...payment.result,
      status: delivery.phase === 'COMPLETED' ? 'CONFIRMED' : 'PENDING', message: delivery.message } }
  }
  async prepare(userId: string, discoveryId: string, candidateId: string, owner: string) {
    const saved = await this.discoveries.get(userId, discoveryId)
    if (!saved || Date.parse(saved.reply.expiresAt) <= Date.now()) throw new InputError('Kết quả tìm kiếm đã hết hạn hoặc không thuộc tài khoản. Tìm lại NFT.')
    if (saved.reply.intent.priceDiscoveryOnly) throw new InputError('Chưa có mức chi được xác nhận. Hãy nêu mức tối đa bằng SOL và ủy quyền ngân sách cho Na trước khi mua.')
    const candidate = saved.reply.candidates.find(c => c.id === candidateId)
    if (!candidate) throw new InputError('NFT không thuộc kết quả tìm kiếm này.')
    if (candidate.sourceNetwork === 'mainnet') throw new InputError('MAINNET_READ_ONLY: NFT Mainnet chỉ để xem, không được phép tạo giao dịch mua.')
    const maximumLamports = Number(saved.reply.intent.maximumLamports)
    // Refuse to prepare anything the vault would not allow. The program is still the final authority.
    const fresh = await this.refresh(candidate)
    const record: AcquisitionRecord = { id: discoveryId, owner, candidate: fresh, maximumLamports }
    const existing = await this.acquisitions.get(userId, discoveryId)
    if (existing) throw new InputError('Yêu cầu này đã được chuẩn bị trước đó. Tạo tìm kiếm mới để tránh chi hai lần.')
    await this.acquisitions.put(userId, record.id, record, true)
    const stored = (await this.acquisitions.get(userId, record.id))!
    if (stored.owner !== owner || stored.candidate.id !== candidateId) throw new InputError('Yêu cầu này đã gắn với ví hoặc NFT khác. Tạo tìm kiếm mới.')
    await this.metadata.put('public', simulationMetadataId(userId, record.id), stored.candidate, true)
    const result = await this.executor.prepare(record.id, stored.candidate, stored.maximumLamports, owner, userId)
    acquisitionLog('quote', { outcome: result.status })
    return result
  }
  async submit(userId: string, id: string, signed: string) {
    const record = await this.acquisitions.get(userId, id)
    if (!record) throw new InputError('Không tìm thấy yêu cầu của tài khoản này.')
    if (record.candidate.sourceNetwork === 'mainnet') throw new InputError('MAINNET_READ_ONLY: Không gửi giao dịch cho NFT Mainnet.')
    // Never require the old listing to still exist before reconciling an already submitted transaction.
    const previous = await this.executor.status(id, userId)
    if (previous.status !== 'NOT_SUBMITTED') return this.finish(userId, record, previous)
    await this.refresh(record.candidate)
    const receipt = await this.executor.submit(id, signed, userId)
    acquisitionLog('execution', { outcome: receipt.status })
    return this.finish(userId, record, receipt)
  }
  private async finish(userId: string, record: AcquisitionRecord, receipt: Awaited<ReturnType<ExecutionEngine['status']>>) {
    await this.portfolio.record(userId, record.id, record.owner, record.candidate, receipt)
    return { ...receipt, phase: receipt.status === 'CONFIRMED' ? 'COMPLETED' as const
      : receipt.status === 'PENDING' ? 'DELIVERY_PENDING' as const : 'PAYMENT_PENDING' as const }
  }
  async status(userId: string, id: string) {
    const record = await this.acquisitions.get(userId, id)
    if (!record) throw new InputError('Không tìm thấy yêu cầu của tài khoản này.')
    return this.finish(userId, record, await this.executor.status(id, userId))
  }
  async publicMetadata(id: string) {
    const source = await this.metadata.get('public', id)
    return source ? { name: `Na Simulation - ${source.name}`.slice(0, 80),
      description: 'Devnet simulation only. This token is not the original marketplace NFT and has no investment value.',
      image: source.image?.startsWith('https://') ? source.image : undefined,
      attributes: [{ trait_type: 'Execution', value: 'Devnet Simulation' }, { trait_type: 'Source network', value: source.sourceNetwork },
        { trait_type: 'Source mint', value: source.mint ?? 'mock' }], external_url: source.listing.url || undefined } : undefined
  }
}
