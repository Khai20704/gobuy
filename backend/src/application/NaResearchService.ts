import { randomUUID } from 'node:crypto'
import { toSearchIntent, toPurchaseIntent } from '../services/search/commerceIntent.js'
import { explicitSpendingConstraints } from '../services/ai/spendingConstraints.js'
import { researchResponseSchema, type CommerceTwin, type DecisionInput, type DecisionResponse, type RankedCandidate,
  type RankingWeights, type ResearchResponse, type TwinPreferences, type ExchangeRate, type PurchaseAuthorization, type PurchaseState, type PurchaseIntent, type PageContext, type ActionLog } from '@gobuy/shared'
import type { StructuredLLMProvider } from '../adapters/llm/StructuredLLMProvider.js'
import { InputError } from '../schemas/search.js'
import { IntentExtractor } from '../services/ai/intentExtractor.js'
import type { LLMMessage } from '../ai/LLMProvider.js'
import { explainRecommendations } from '../services/ai/explainRecommendations.js'
import { SearchAggregator } from '../services/search/SearchAggregator.js'
import { applyTwinIntent, rankCandidates } from '../services/ranking/rankCandidates.js'
import { trustedSellerPremium } from '../services/verification/priceResearch.js'
import { verifyCandidate } from '../services/verification/verifyCandidates.js'
import { deriveTwin } from '../services/twin/CommerceTwinService.js'
import type { TwinStore } from '../services/twin/TwinStore.js'
import { createResearchHandoff } from '../services/approval/researchHandoff.js'
import type { ExchangeRateProvider } from '../services/currency/SolExchangeRates.js'
import { intentHash, PurchaseService } from '../services/payment/PurchaseService.js'

type CachedSearch = { session: string; response: ResearchResponse; ranked: RankedCandidate[]; expires: number; messages: LLMMessage[] }
export class NaResearchService {
  private readonly searches = new Map<string, CachedSearch>()
  private readonly active = new Set<string>()
  constructor(private readonly extractor: IntentExtractor, private readonly searcher: SearchAggregator,
    private readonly store: TwinStore, private readonly options: { mode: 'real' | 'mock'; llm?: StructuredLLMProvider; weights?: RankingWeights; ttlMs?: number;
      rates?: ExchangeRateProvider; payment?: PurchaseService }) {}
  async getActions(session: string) { return (await this.store.read(session)).actions }
  private async log(session: string, entry: Omit<ActionLog, 'id' | 'timestamp'>) {
    await this.store.update(session, current => ({ ...current, actions: [{ ...entry, id: randomUUID(), timestamp: new Date().toISOString() }, ...current.actions].slice(0, 200) }))
  }
  async getTwin(session: string): Promise<CommerceTwin> {
    const stored = await this.store.read(session)
    return deriveTwin(stored.explicit, stored.history)
  }
  async setPreferences(session: string, explicit: TwinPreferences) {
    const stored = await this.store.update(session, current => ({ ...current, explicit }))
    return deriveTwin(stored.explicit, stored.history)
  }
  async search(session: string, text: string, previousSearchId?: string, structuredIntent?: PurchaseIntent, pageContext?: PageContext): Promise<ResearchResponse> {
    if (this.active.has(session) || this.active.size >= 20) throw new InputError('A search is already running. Please try again shortly.')
    for (const [id, value] of this.searches) if (value.expires <= Date.now()) this.searches.delete(id)
    if (this.searches.size >= 500) throw new InputError('Research capacity reached. Please try again in a few minutes.')
    this.active.add(session)
    try {
      if (structuredIntent && (await this.store.read(session)).actions.some(a => a.requestId === structuredIntent.requestId)) throw new InputError('This request ID was already used. Start a new request.')
      const previous = previousSearchId ? this.searches.get(previousSearchId) : undefined
      if (previousSearchId && (!previous || previous.session !== session || previous.expires <= Date.now())) {
        throw new InputError('The earlier request expired or belongs to another browser. State the product and new budget again.')
      }
      // Page metadata never enters a model prompt or grants BUY authority. It only scopes read-only lookup.
      const pageBudget = pageContext ? explicitSpendingConstraints(text) : undefined
      const pageIntent: PurchaseIntent | undefined = pageContext ? { requestId: randomUUID(),
        assetType: pageContext.url.includes('magiceden.io') ? 'NFT' : pageContext.url.includes('ondo.finance') ? 'RWA' : 'PHYSICAL',
        query: pageContext.title || text, preferences: { collectionSymbol: pageContext.collectionSymbol },
        ...(pageBudget?.maximum !== undefined && pageBudget.currency ? { budget: { amount: pageBudget.maximum, currency: pageBudget.currency } } : {}) } : undefined
      let structured = structuredIntent ?? pageIntent
      if (structured && !pageContext) {
        const direct = explicitSpendingConstraints(text)
        if (structured.budget && direct.currency && structured.budget.currency !== direct.currency) throw new InputError('The request currency conflicts with the structured budget. Use one currency.')
        const currency = structured.budget?.currency ?? direct.currency
        if (direct.maximum !== undefined && currency) structured = { ...structured, budget: {
          amount: Math.min(direct.maximum, structured.budget?.amount ?? direct.maximum), currency,
        } }
      }
      const [{ intent: extractedIntent, mode: intentMode, ai }, twin] = await Promise.all([structured
        ? Promise.resolve({ intent: { ...toSearchIntent(structured), ...(pageContext ? { sourceClassification: 'UNTRUSTED_EXTERNAL_CONTENT' as const } : {}) }, mode: 'structured' as const, ai: undefined }) : this.extractor.extract(text, previous?.response.intent, {
        messages: previous?.messages,
        protectedContext: previous ? { previousIntent: previous.response.intent, authorization: previous.response.authorization,
          selectedEvidence: previous.response.recommendations, purchase: previous.response.purchase } : undefined,
      }), this.getTwin(session)])
      const intent = applyTwinIntent(extractedIntent, twin)
      // Spending authority comes only from this request (or an explicit budget update), never Twin history.
      const authorization: PurchaseAuthorization | undefined = extractedIntent.action === 'BUY' && extractedIntent.maxPrice !== undefined && extractedIntent.currency
        ? { id: randomUUID(), action: 'BUY', maximum: extractedIntent.maxPrice, currency: extractedIntent.currency, quantity: extractedIntent.quantity ?? 1, intentHash: intentHash(intent),
          createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 5 * 60000).toISOString() } : undefined
      const allowLLM = !structured && intentMode === 'llm'
      const found = await this.searcher.search(intent, { allowLLM })
      const exchangeRates: ExchangeRate[] = []
      let rateUnavailable = false
      const currencies = intent.currency === 'SOL' ? [...new Set(found.items.flatMap(item => item.currency && item.currency !== 'SOL' ? [item.currency] : []))]
        : found.items.some(item => item.currency === 'SOL') && intent.currency ? [intent.currency] : []
      if (currencies.length && this.options.mode === 'real') {
        try { exchangeRates.push(...await this.options.rates?.getRates(currencies) ?? []); rateUnavailable = exchangeRates.length < currencies.length }
        catch { rateUnavailable = true }
      }
      const ranked = rankCandidates(found.items, intent, twin, this.options.weights, exchangeRates)
      // A real result must come from a comparison, never a lone search hit or a fixture.
      const liveOffers = found.items.filter(item => item.mode === 'real' && item.kind !== 'web-page')
      const selectable = this.options.mode === 'real' ? ranked.filter(candidate => candidate.item.mode === 'real') : ranked
      const comparisonCount = found.items.filter(item => item.mode === 'real').length
      const recommendations = this.options.mode === 'real' && comparisonCount < 2 ? [] : selectable.slice(0, 1)
      const explanationMode = await explainRecommendations(recommendations, allowLLM ? this.options.llm : undefined)
      const modes = new Set(found.items.map(item => item.mode))
      const mode = modes.size > 1 ? 'mixed' : modes.values().next().value ?? this.options.mode
      const expires = Date.now() + (this.options.ttlMs ?? 15 * 60_000)
      const allSkipped = found.reports.length === 0 || found.reports.every(report => report.status === 'skipped')
      const allUnavailable = !found.reports.some(report => report.status === 'ok')
      const outside = intent.maxPrice === undefined || !intent.currency || recommendations.length ? []
        : rankCandidates(found.items, { ...intent, maxPrice: Number.MAX_SAFE_INTEGER, minPrice: undefined }, twin, this.options.weights, exchangeRates)
          .filter(candidate => candidate.item.mode === 'real' && candidate.verification.effectivePrice !== undefined
            && candidate.verification.effectivePrice > intent.maxPrice! && candidate.verification.seller.score >= 60)
          .sort((a, b) => a.verification.effectivePrice! - b.verification.effectivePrice!)
      const budgetSuggestion = outside[0] ? { item: outside[0].item, minimum: outside[0].verification.effectivePrice!, currency: intent.currency!,
        explanation: 'Lowest credible effective cost among the retrieved offers. This is a suggestion, not authorization to exceed your limit.' } : undefined
      const status: ResearchResponse['status'] = allSkipped ? 'SETUP_REQUIRED' : allUnavailable ? 'SEARCH_UNAVAILABLE'
        : recommendations.length ? 'SELECTED' : budgetSuggestion ? 'BUDGET_TOO_LOW'
          : intent.action === 'BUY' && (!authorization || ranked.length === 0 && found.items.length > 0) ? 'NEEDS_INFORMATION' : 'NO_MATCH'
      const nextStep = status === 'SETUP_REQUIRED' ? 'Configure live search in backend/.env: SERPAPI_KEY, EBAY_ACCESS_TOKEN, MAGIC_EDEN_ENABLED or optional OPENAI_API_KEY web search. LLM providers are configured independently. Restart the backend after changes.'
        : status === 'SEARCH_UNAVAILABLE' ? 'The connected search services did not respond successfully. Check provider status and retry; your requirements and budget are unchanged.'
          : budgetSuggestion ? `Explicitly set a new maximum of at least ${budgetSuggestion.minimum} ${budgetSuggestion.currency} to continue, or change a requirement. Na will research and verify again.`
            : intent.action === 'BUY' && !authorization ? 'State an explicit maximum budget and currency for this purchase. Previous purchases and Twin settings cannot authorize spending.'
              : recommendations.length ? 'Review the selected evidence. A purchase requires a current BUY instruction and approval by the GoBuy payment layer.'
                : 'No purchase was made. The missing evidence and unmet requirements are listed below; Na will not silently relax them.'
      let purchase: PurchaseState = { status: 'NOT_REQUESTED', message: 'This is a research request, not an instruction to spend.' }
      if (intent.action === 'BUY') {
        const payment = this.options.payment ?? new PurchaseService()
        purchase = authorization && recommendations[0] ? await payment.purchase(session, authorization, recommendations[0], intent, async () => {
          const refreshed = await this.searcher.search(intent, { allowLLM })
          return refreshed.items.find(item => item.id === recommendations[0].item.id && item.productUrl === recommendations[0].item.productUrl)
        }, this.options.rates) : { status: 'BLOCKED', message: 'No purchase: the current offer or authorization does not meet every requirement.' }
        if (!payment.available) purchase = { status: 'BLOCKED', message: 'GoBuy payment is not connected. No purchase or SOL transfer was made.' }
      }
      const warnings = [
        ...(intentMode === 'deterministic' || intentMode === 'dev-parser' && this.options.mode === 'real' ? ['AI reasoning is temporarily unavailable. Search and on-chain validation are still available. The limited parser preserves explicit constraints; use structured search for precise filters.'] : []),
        ...(pageContext ? ['Page metadata is UNTRUSTED_EXTERNAL_CONTENT. Page prices and seller claims are not verification evidence.'] : []),
        ...(mode !== 'real' ? ['DEVELOPMENT DATA: mock fixtures are synthetic, not live marketplace results.'] : []),
        ...(allowLLM && this.options.llm && explanationMode === 'deterministic' && recommendations.length ? ['LLM explanation unavailable; showing deterministic evidence-based reasons.'] : []),
        ...(rateUnavailable ? ['A fresh SOL exchange rate could not be retrieved for every offer. Missing conversions remain UNKNOWN.'] : []),
        ...(!allUnavailable && this.options.mode === 'real' && comparisonCount < 2 ? ['The source returned too little evidence to compare competing offers.'] : []),
        ...(!recommendations.length ? [...new Set(found.items.flatMap(item => { const v = verifyCandidate(item, intent, exchangeRates); return [...v.hardViolations, ...v.unmetRequirements] }))].slice(0, 10) : []),
      ]
      const requestId = structured?.requestId ?? randomUUID()
      const discoveries = !recommendations.length ? found.items.map(item => {
        const verification = verifyCandidate(item, intent, exchangeRates)
        return { item, match: verification.productMatch, reasons: [...verification.hardViolations, ...verification.unmetRequirements] }
      }).sort((a, b) => b.match - a.match).slice(0, 10).map(({ item, reasons }) => ({ item,
        reasons: reasons.length ? reasons : ['Not enough comparable offers to make a selection.'] })) : []
      const response = researchResponseSchema.parse({ searchId: requestId, purchaseIntent: toPurchaseIntent(requestId, text, intent), ai, expiresAt: new Date(expires).toISOString(), mode,
        intent, intentMode, explanationMode, recommendations, discoveries, providers: found.reports, warnings, twin,
        researchedCount: found.items.length, eligibleCount: selectable.length,
        status, nextStep, exchangeRates, authorization, purchase, budgetSuggestion,
        summary: recommendations.length ? mode === 'mock' ? 'Development demonstration: Na selected one synthetic example after comparing the fixtures. This is not a shopping recommendation.'
          : `I researched ${comparisonCount} listings and source pages, compared ${liveOffers.length} live offers and selected the best fit for your request.`
          : status === 'SETUP_REQUIRED' ? 'Live search is not connected yet. Na has not searched for this product, so this is not a no-match result.'
            : status === 'SEARCH_UNAVAILABLE' ? 'Live search is temporarily unavailable. Na could not complete the research.'
              : budgetSuggestion ? `No sufficiently verified ${intent.product ?? 'product'} fits your ${intent.maxPrice} ${intent.currency} limit. The lowest credible option found costs ${budgetSuggestion.minimum} ${budgetSuggestion.currency}.`
                : 'Na could not verify enough current information to make a reliable selection. No product was recommended.',
      })
      const selectedItem = recommendations[0]?.item
      await this.log(session, { requestId, request: text, status: 'SEARCHED', provider: found.reports.map(r => r.provider).join(', ').slice(0, 200), reason: response.summary })
      await this.log(session, { requestId, request: text, status: selectedItem ? 'PROPOSED' : allUnavailable ? 'FAILED' : 'NO_MATCH',
        asset: selectedItem?.title, price: selectedItem?.price, currency: selectedItem?.currency, provider: selectedItem?.source ?? 'Na', reason: response.nextStep })
      const previousSearches = [...this.searches.entries()].filter(([, value]) => value.session === session)
      for (const [id] of previousSearches.slice(0, Math.max(0, previousSearches.length - 9))) this.searches.delete(id)
      // Normalized server-owned state survives provider switches; no external conversation/thread IDs.
      // Raw user messages are retained. Only rendered redundant summaries are discardable.
      const messages: LLMMessage[] = [...previous?.messages ?? [], { role: 'user', content: text },
        { role: 'assistant', content: response.summary, discardable: true }]
      this.searches.set(response.searchId, { session, response, ranked, expires, messages })
      return response
    } finally { this.active.delete(session) }
  }
  async decide(session: string, input: DecisionInput): Promise<DecisionResponse> {
    // Resolve candidates only from this session's server-held results; never accept client prices or scores.
    const current = await this.store.read(session)
    const prior = current.history.find(d => d.searchId === input.searchId && d.item.id === input.candidateId)
    if (prior) {
      if (prior.outcome !== input.outcome || prior.reason !== input.reason) throw new InputError('This recommendation already has a different decision. Search again to reconsider it.')
      return { decision: prior, twin: deriveTwin(current.explicit, current.history), ...(prior.outcome === 'approve' ? { handoff: createResearchHandoff(prior) } : {}) }
    }
    const search = this.searches.get(input.searchId)
    if (!search || search.session !== session || search.expires <= Date.now()) throw new InputError('Research expired or unavailable for this browser. Search again before deciding.')
    const selected = search.response.recommendations.find(candidate => candidate.item.id === input.candidateId)
    if (!selected) throw new InputError('Candidate was not recommended by this search.')
    const premium = trustedSellerPremium(selected, search.ranked)
    const decision = { id: randomUUID(), searchId: input.searchId, outcome: input.outcome, reason: input.reason,
      item: selected.item, trustScore: selected.verification.seller.score, at: new Date().toISOString(),
      trustedPricePremium: selected.verification.productMatch >= 70 && selected.verification.seller.score >= 60
        && premium !== undefined && premium > 0 && premium <= 0.05 + 1e-8 ? Math.min(0.05, premium) : undefined }
    const stored = await this.store.update(session, value => {
      const duplicate = value.history.find(d => d.searchId === input.searchId && d.item.id === input.candidateId)
      if (duplicate) {
        if (duplicate.outcome !== input.outcome || duplicate.reason !== input.reason) throw new InputError('This recommendation already has a different decision.')
        return value
      }
      return { ...value, history: [decision, ...value.history].slice(0, 200) }
    })
    await this.log(session, { requestId: input.searchId, request: search.response.purchaseIntent?.query ?? 'Recommendation review',
      asset: selected.item.title, price: selected.item.price, currency: selected.item.currency, provider: selected.item.source,
      status: input.outcome === 'reject' ? 'REJECTED' : 'PROPOSED',
      reason: input.outcome === 'reject' ? input.reason ?? 'User rejected the recommendation.' : 'User requested review; on-chain approval still required.' })
    const saved = stored.history.find(d => d.searchId === input.searchId && d.item.id === input.candidateId)!
    return { decision: saved, twin: deriveTwin(stored.explicit, stored.history), ...(saved.outcome === 'approve' ? { handoff: createResearchHandoff(saved) } : {}) }
  }
}
