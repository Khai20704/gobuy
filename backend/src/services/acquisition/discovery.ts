import { z } from 'zod'
import { HeliusError } from '../../nft/helius/HeliusClient.js'
import { namedNFTPurchaseName, nftCandidateSchema, nftSearchIntentSchema, nftInvestmentIntentSchema, type DiscoveryReply, type NFTCandidate, type NFTSearchIntent } from '@gobuy/shared'
import { investmentIntent } from '../nft-intelligence/NFTIntent.js'
import type { LLMRouter } from '../../ai/LLMRouter.js'
import { parseModelJSON } from '../../ai/LLMRouter.js'
import { InputError } from '../../schemas/search.js'
import { toLamports } from '../payment/PurchaseService.js'
import { ProviderRequestError, type ProviderFailureCode } from '../search/http.js'
import { NFTAcquisitionRanker } from './NFTAcquisitionRanker.js'
import type { NFTProviderResult } from '../nft-intelligence/marketContracts.js'
import { budgetExpression, strictBudget, normalizeIntentText, investmentRequest, searchOnlyRequest,
  explicitPriorities, subjectText, expandSubjects, extractCollectionQuery, extractNamedCollectionQuery, NFT_INTENT_PROMPT } from './intentLanguage.js'

export interface NFTDiscoveryProvider {
  readonly name: string
  search(request: NFTSearchIntent, signal: AbortSignal): Promise<NFTCandidate[] | NFTProviderResult>
  refresh(candidate: NFTCandidate, signal: AbortSignal): Promise<NFTCandidate | undefined>
}
export interface MetadataProvider {
  enrich(candidate: NFTCandidate, signal: AbortSignal): Promise<NFTCandidate>
}
export function acquisitionConfig(env: NodeJS.ProcessEnv = process.env) {
  const config = z.object({ NFT_DISCOVERY_MODE: z.enum(['marketplace', 'mock']).default('marketplace'),
    NFT_MARKETPLACE_PROVIDER: z.literal('tensor').default('tensor'),
    NFT_ASSET_PROVIDER: z.literal('helius').default('helius'),
    HELIUS_NETWORK: z.literal('devnet').default('devnet'),
    DISCOVERY_NETWORK: z.literal('devnet').default('devnet'),
    SOLANA_EXECUTION_NETWORK: z.literal('devnet').default('devnet'),
    DEMO_MODE: z.literal('true').default('true'),
    ENABLE_MAINNET_EXECUTION: z.literal('false').default('false'),
    NFT_PROVIDER_TIMEOUT_MS: z.coerce.number().int().min(100).max(45000).default(30000),
  }).parse(env)
  return { ...config, heliusConfigured: Boolean(env.HELIUS_API_KEY?.trim()) }
}
export function acquisitionLog(event: string, data: { count?: number; provider?: string; outcome?: string;
  code?: string; httpStatus?: number; latencyMs?: number; received?: number; accepted?: number; schemaRejected?: number;
  budgetRejected?: number; finalCandidates?: number } = {}) {
  console.info('[Na Acquisition]', JSON.stringify({ event, ...data }))
}
function providerMessage(code: ProviderFailureCode) {
  const messages: Record<ProviderFailureCode, string> = {
    DISABLED: 'Nguồn dữ liệu đã tắt.', AUTH_REQUIRED: 'Tính năng này cần API key.', NETWORK_ERROR: 'Lỗi kết nối marketplace.',
    SCHEMA_MISMATCH: 'Dữ liệu marketplace không khớp schema.', NO_MATCH: 'Không có listing khớp trong dữ liệu đã kiểm tra.',
    AUTHENTICATION_FAILED: 'API key bị từ chối.',
    ACCESS_FORBIDDEN: 'API không cấp quyền cho endpoint.',
    RATE_LIMITED: 'API đang giới hạn lượt truy cập.',
    PROVIDER_UNAVAILABLE: 'Dịch vụ marketplace đang lỗi.',
    INVALID_RESPONSE: 'API trả dữ liệu không đúng định dạng.',
    RESPONSE_TOO_LARGE: 'Phản hồi marketplace vượt giới hạn an toàn.',
    TIMEOUT: 'Marketplace phản hồi quá thời gian.',
    NO_DATA: 'Marketplace không trả dữ liệu có thể dùng.',
  }
  return messages[code]
}
export const words = (text: string) => text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').match(/[a-z0-9]+/g) ?? []
const stop = new Set('find me an a the nft collection collections artwork buc themed theme under below maximum max sol buy purchase acquire any whatever random i want need to tim cho toi tui minh mua ve duoi de va can muon giup voi bo suu tap hiem nhat rare rarest rarity cheap cheapest affordable please looking for show recommend suggest kiem xem goi y nha nhe thoi mot ngan sach tam khoang do khong qua bat ky'.split(' '))
export function literalTerms(text: string) { return [...new Set(words(subjectText(text)).filter(w => !stop.has(w) && !/^\d+$/.test(w) && w.length > 1))].slice(0, 12) }

export class NFTIntentParser {
  constructor(private readonly router?: Pick<LLMRouter, 'generate' | 'isConfigured'>) {}
  async parse(text: string): Promise<NFTSearchIntent> {
    const normalized = words(text).join(' ')
    if (/\b(electronics|dien tu)\b/.test(normalized)) throw new InputError('Electronics không được phép trong delegated-spending MVP NFT/RWA.')
    // Financial authority comes from explicit input, never an LLM's inferred budget.
    const value = normalizeIntentText(text)
    const budgets = [...value.matchAll(budgetExpression)]
    const highestPrice = /\b(dat nhat|gia cao nhat|most expensive|highest price)\b/.test(normalized)
    const priceDiscoveryOnly = budgets.length === 0 && !!(extractCollectionQuery(text) ?? extractNamedCollectionQuery(text))
    if ((!priceDiscoveryOnly && budgets.length !== 1) || /\b(?:usd|usdc|eur|vnd)\b|\$/.test(value)) throw new InputError('Nêu một ngân sách bằng SOL, ví dụ: Find me an ocean-themed NFT under 1 SOL.')
    const budget = budgets[0], amount = priceDiscoveryOnly ? 10 : Number(budget[2].replace(',', '.'))
    if (!Number.isFinite(amount) || amount <= 0 || amount > 10) throw new InputError('Ngân sách mô phỏng phải lớn hơn 0 và không quá 10 SOL.')
    // Search ceiling is not spending authority. prepare rejects discovery-only requests.
    const maximum = priceDiscoveryOnly ? 9007199254740991n : toLamports(amount, 'down') - (strictBudget.test(budget[1] ?? '') ? 1n : 0n)
    if (maximum <= 0n) throw new InputError('Ngân sách quá nhỏ.')
    let investment = investmentIntent(text)
    let requestKind: NFTSearchIntent['requestKind'] = investment || investmentRequest(text) ? 'investment_research' : 'discovery'
    let terms = requestKind === 'investment_research' ? [] : expandSubjects(literalTerms(text))
    let semanticQuery = text, parser: NFTSearchIntent['parser'] = 'literal'
    let parserStatus: NFTSearchIntent['parserStatus'] = this.router?.isConfigured() ? 'unavailable' : 'not_configured'
    let priorities = explicitPriorities(text)
    let collectionSymbol: string | undefined
    const exactNFTName = namedNFTPurchaseName(text)
    const collectionQuery = exactNFTName ? undefined : extractCollectionQuery(text)
      ?? extractNamedCollectionQuery(text)
      ?? text.match(/\b[a-z][a-z0-9]*_[a-z0-9_]+\b/i)?.[0]
    if (collectionQuery) {
      parserStatus = 'ready'
      collectionSymbol = /^[a-z0-9]+(?:[_-][a-z0-9]+)+$/i.test(collectionQuery) ? collectionQuery : undefined
      terms = words(collectionQuery).filter(term => term.length >= 2).slice(0, 12)
    }
    let broadSearch = false
    if (this.router?.isConfigured() && !collectionQuery) {
      const schema = z.object({ semanticQuery: z.string().min(1).max(500), terms: z.array(z.string().min(2).max(60)).max(12),
        requestKind: z.enum(['discovery', 'investment_research']).optional(),
        collectionSymbol: z.string().regex(/^[a-zA-Z0-9_-]{1,120}$/).nullable().optional(),
        priorities: z.array(z.enum(['rarity', 'price', 'visual'])).max(3).optional(),
        investment: nftInvestmentIntentSchema.nullable().optional(),
      }).strict()
      try {
        const result = await this.router.generate({ operation: 'nft_intent', responseFormat: 'json',
          jsonSchema: { name: 'nft_intent', schema: { ...z.toJSONSchema(schema), required: Object.keys(schema.shape) } },
          totalTimeoutMs: 24000, maxTokens: 1200, validate: data => schema.parse(data),
          systemPrompt: NFT_INTENT_PROMPT,
          messages: [{ role: 'user', content: text }],
        })
        const parsed = schema.parse(parseModelJSON(result.content))
        if (!collectionQuery) terms = [...new Set(parsed.terms)]
        if (parsed.requestKind === 'investment_research') requestKind = 'investment_research'
        // Explicit objectives and authority come from the user's text, never model inventions.
        // A model-proposed symbol is never canonical. The market provider resolves user text.
        semanticQuery = parsed.semanticQuery; parser = 'llm'; parserStatus = 'ready'
      } catch { acquisitionLog('intent', { outcome: 'literal_fallback' }) }
    }
    if (!terms.length) { terms = ['nft']; broadSearch = true }
    if (exactNFTName) { terms = words(exactNFTName).filter(term => term.length >= 2).slice(0, 12); broadSearch = false }
    acquisitionLog('intent', { outcome: parser })
    const action = !searchOnlyRequest(text)
      && /\b(?:buy|purchase|acquire|mua)\b/.test(normalized) ? 'BUY' : 'SEARCH'
    const objective = highestPrice ? 'HIGHEST_PRICE' : investment ? ({
      strongest_momentum: 'STRONGEST_MOMENTUM', most_bought: 'MOST_BOUGHT', trending: 'TRENDING',
      best_liquidity: 'BEST_LIQUIDITY', value: 'GENERAL_MATCH',
    } as const)[investment.objective] : priorities.includes('price') ? 'LOWEST_PRICE'
      : priorities.includes('rarity') ? 'RARITY' : action === 'BUY' ? 'BEST_OVERALL' : 'GENERAL_MATCH'
    return nftSearchIntentSchema.parse({ assetType: 'NFT', semanticQuery, terms, maximumLamports: maximum.toString(), currency: 'SOL',
      intent: 'acquire_asset', action, broadSearch, priorities, objective,
      ...(exactNFTName ? { exactNFTName } : {}),
      ...(priceDiscoveryOnly ? { priceDiscoveryOnly: true } : { maxPriceSol: amount }),
      ...(collectionQuery ? { collectionQuery } : {}),
      ...(collectionSymbol ? { collectionSymbol } : {}), parser, parserStatus, requestKind, investment })
  }
}
export function relevance(terms: string[], text: string) {
  const haystack = new Set(words(text))
  return terms.filter(term => words(term).every(word => haystack.has(word))).length / terms.length
}
const collectionIdentity = (value: string) => value.toLowerCase().normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '')
export function evaluateCandidates(candidates: NFTCandidate[], intent: NFTSearchIntent, limit = 6,
  resolvedSymbols: string[] = []) {
  return candidates.flatMap(raw => {
    const parsed = nftCandidateSchema.safeParse(raw)
    if (!parsed.success) return []
    const c = parsed.data
    if (intent.exactNFTName && normalizeIntentText(c.name).trim() !== normalizeIntentText(intent.exactNFTName).trim()) return []
    if (BigInt(c.listing.priceLamports) > BigInt(intent.maximumLamports) || BigInt(c.listing.priceLamports) <= 0n
      || Date.now() - Date.parse(c.listing.observedAt) > 120000 || Date.parse(c.listing.observedAt) > Date.now() + 5000
      || c.mint && intent.excludedMints.includes(c.mint)) return []
    const candidateText = [c.name, c.description, c.collection, ...c.attributes.map(a => `${a.name} ${a.value}`)].join(' ')
    if (intent.avoidTerms.some(term => relevance([term], candidateText) > 0)) return []
    const collectionMatch = !!intent.collectionQuery && (collectionIdentity(c.collection) === collectionIdentity(intent.collectionQuery)
      || !!intent.collectionSymbol && collectionIdentity(c.collection) === collectionIdentity(intent.collectionSymbol)
      || resolvedSymbols.some(symbol => collectionIdentity(c.collection) === collectionIdentity(symbol)))
    const score = intent.broadSearch ? 0.5 : Math.max(relevance(intent.terms, candidateText), collectionMatch ? 0.8 : 0)
    if (!score) return []
    return [{ ...c, relevance: score, reasons: c.sourceNetwork === 'mainnet' ? c.reasons : ['Tên, mô tả hoặc thuộc tính khớp từ khóa chủ đề.', intent.priceDiscoveryOnly ? 'Tra cứu giá; chưa được cấp quyền chi tiêu.' : 'Giá niêm yết nằm trong ngân sách; phí được kiểm tra khi báo giá.'],
      warnings: [...c.warnings, 'Thông tin do marketplace cung cấp; chưa chứng minh tính xác thực hoặc giá trị đầu tư.'].slice(0, 10) }]
  }).sort((a, b) => b.relevance - a.relevance || Number(BigInt(a.listing.priceLamports) - BigInt(b.listing.priceLamports)))
    .filter((c, index, all) => all.findIndex(other => `${other.sourceNetwork}:${other.mint ?? other.id}` === `${c.sourceNetwork}:${c.mint ?? c.id}`) === index)
    .slice(0, Math.max(1, Math.min(100, limit)))
}
export class DiscoveryEngine {
  constructor(readonly providers: NFTDiscoveryProvider[], private readonly timeoutMs = 15000,
    private readonly ranker = new NFTAcquisitionRanker()) {}
  async search(intent: NFTSearchIntent): Promise<Pick<DiscoveryReply, 'status' | 'sources' | 'candidates' | 'warnings'
    | 'ranking' | 'resolvedCollection' | 'ambiguousCollections' | 'diagnostics' | 'coverage' | 'research'>> {
    const warnings: string[] = []
    const results = await Promise.all(this.providers.map(async provider => {
      const controller = new AbortController()
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const candidates = await Promise.race([provider.search(intent, controller.signal), new Promise<never>((_, reject) => {
          timer = setTimeout(() => { controller.abort(); reject(new Error('timeout')) }, this.timeoutMs)
        })])
        const result = Array.isArray(candidates) ? { candidates } : candidates
        warnings.push(...(result.warnings ?? []))
        acquisitionLog('discovery', { provider: provider.name, count: result.candidates.length, outcome: 'success' })
        return { candidates: result.candidates, result, source: { provider: provider.name, status: 'AVAILABLE' as const } }
      } catch (error) {
        const code: ProviderFailureCode = error instanceof HeliusError ? ({ AUTH_FAILED: 'AUTHENTICATION_FAILED',
          RATE_LIMITED: 'RATE_LIMITED', TIMEOUT: 'TIMEOUT', NETWORK_ERROR: 'NETWORK_ERROR',
          INVALID_RESPONSE: 'INVALID_RESPONSE', ASSET_NOT_FOUND: 'NO_DATA' } as const)[error.code]
          : error instanceof ProviderRequestError ? error.code
          : controller.signal.aborted ? 'TIMEOUT' : 'PROVIDER_UNAVAILABLE'
        const status = error instanceof ProviderRequestError ? error.status : undefined
        if (provider.name === 'tensor-mainnet-readonly' && code === 'AUTH_REQUIRED') {
          warnings.push('Tra cứu Tensor Mainnet cần TENSOR_API_KEY trong backend/.env. Chưa có dữ liệu để kết luận collection hoặc giá; Helius API key không thay thế key Tensor.')
        }
        warnings.push(error instanceof HeliusError && error.code === 'AUTH_FAILED'
          ? 'Helius: API key chưa được cấu hình hoặc bị từ chối (401/403). Kiểm tra HELIUS_API_KEY trong backend/.env và khởi động lại backend.'
          : `${error instanceof HeliusError ? 'Helius' : provider.name}: ${providerMessage(code)} Không dùng catalog giả thay thế.`)
        acquisitionLog('provider_failure', { provider: provider.name, outcome: code, ...(status ? { httpStatus: status } : {}) })
        return { candidates: [], result: undefined, source: { provider: provider.name, status: 'UNAVAILABLE' as const, code, ...(status ? { httpStatus: status } : {}) } }
      } finally { clearTimeout(timer); controller.abort() }
    }))
    const sources = results.map(result => result.source)
    if (!sources.some(source => source.status === 'AVAILABLE')) {
      return { status: 'DATA_UNAVAILABLE' as const, sources, candidates: [], warnings }
    }
    const providerResults = results.flatMap(result => result.result ? [result.result] : [])
    const diagnostics = providerResults.flatMap(result => result.diagnostics ?? [])
    const resolvedCollection = providerResults.find(result => result.resolvedCollection)?.resolvedCollection
    const coverage = providerResults.reduce((total, result) => ({
      collectionsChecked: total.collectionsChecked + (result.coverage?.collectionsChecked ?? 0),
      listingsChecked: total.listingsChecked + (result.coverage?.listingsChecked ?? 0),
      activitiesChecked: total.activitiesChecked + (result.coverage?.activitiesChecked ?? 0),
    }), { collectionsChecked: 0, listingsChecked: 0, activitiesChecked: 0 })
    const resolvedSymbols = providerResults.flatMap(result => result.resolvedCollection ? [result.resolvedCollection.symbol, result.resolvedCollection.name] : [])
    const eligible = evaluateCandidates(results.flatMap(result => result.candidates), intent, 100, resolvedSymbols)
    // Never compare Devnet test prices against real Mainnet SOL prices.
    const selectedDevnet = this.ranker.select(eligible.filter(candidate => candidate.sourceNetwork !== 'mainnet'), intent)
    const mainnetResearch = providerResults.find(result => result.research)
    if (!selectedDevnet && mainnetResearch?.research) {
      return { status: mainnetResearch.status as DiscoveryReply['status'], candidates: [], sources, warnings,
        research: mainnetResearch.research, diagnostics, coverage }
    }
    if (!selectedDevnet && sources.some(source => source.provider === 'helius-mainnet-research' && source.status === 'UNAVAILABLE')) {
      return { status: 'PROVIDER_UNAVAILABLE', candidates: [], sources, warnings, diagnostics, coverage }
    }
    const mainnet = eligible.filter(candidate => candidate.sourceNetwork === 'mainnet')
      .sort((a, b) => (intent.objective === 'HIGHEST_PRICE' ? -1 : 1)
        * Number(BigInt(a.listing.priceLamports) - BigInt(b.listing.priceLamports)))[0]
    const selected = selectedDevnet ?? (mainnet && ['LOWEST_PRICE', 'HIGHEST_PRICE'].includes(intent.objective ?? '')
      ? { candidate: mainnet, ranking: undefined } : undefined)
    acquisitionLog('evaluation', { count: eligible.length })
    const common = { sources, warnings, diagnostics, resolvedCollection, coverage }
    if (!selected && sources.some(source => source.provider === 'tensor-mainnet-readonly' && source.status === 'UNAVAILABLE')) {
      return { ...common, status: 'DATA_UNAVAILABLE' as const, candidates: [] }
    }
    if (!selected && !eligible.length) {
      if (providerResults.some(result => result.status === 'COLLECTION_AMBIGUOUS')) {
        const matches = providerResults.find(result => result.status === 'COLLECTION_AMBIGUOUS')?.ambiguousCollections ?? []
        return { ...common, status: 'COLLECTION_AMBIGUOUS' as const, candidates: [], ambiguousCollections: matches }
      }
      if (providerResults.some(result => result.status === 'COLLECTION_NOT_FOUND')) {
        return { ...common, status: 'COLLECTION_NOT_FOUND' as const, candidates: [] }
      }
    }
    return selected ? { ...common, status: 'MATCHED' as const, candidates: [selected.candidate], ranking: selected.ranking }
      : { ...common, status: intent.objective && ['MOST_BOUGHT', 'STRONGEST_MOMENTUM', 'TRENDING', 'BEST_LIQUIDITY', 'RARITY'].includes(intent.objective) && eligible.length ? 'INSUFFICIENT_DATA' as const : !eligible.length ? 'NO_MATCH' as const
        : intent.action === 'BUY' ? 'NO_SAFE_PURCHASE' as const : 'INSUFFICIENT_DATA' as const,
      candidates: [], warnings: eligible.length
        ? [...warnings, 'Không có ứng viên đạt ngưỡng điểm, độ tin cậy và rủi ro cho phép; không tạo giao dịch.']
        : warnings }
  }
}
