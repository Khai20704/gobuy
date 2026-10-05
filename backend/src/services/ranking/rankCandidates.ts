import { DEFAULT_RANKING_WEIGHTS, rankingWeightsSchema, type CandidateItem, type CommerceTwin,
  type RankedCandidate, type RankingWeights, type SearchIntent, type ExchangeRate } from '@gobuy/shared'
import { verifyCandidate, normalized } from '../verification/verifyCandidates.js'
import { comparePrices, trustedSellerPremium } from '../verification/priceResearch.js'

export function applyTwinIntent(intent: SearchIntent, twin: CommerceTwin): SearchIntent {
  const prefs = twin.effective
  return { ...intent,
    // Budgets are scoped to the current request, never inherited from persistent preferences.
    preferences: { ...intent.preferences, authentic: intent.preferences.authentic ?? prefs.authentic,
      condition: intent.preferences.condition ?? prefs.condition, shippingCountry: intent.preferences.shippingCountry ?? prefs.shippingCountry,
      minSellerTrust: intent.preferences.minSellerTrust ?? prefs.minSellerTrust, priceSensitivity: intent.preferences.priceSensitivity ?? prefs.priceSensitivity } }
}

export function rankCandidates(items: CandidateItem[], intent: SearchIntent, twin: CommerceTwin, configured: RankingWeights = DEFAULT_RANKING_WEIGHTS, rates: ExchangeRate[] = []): RankedCandidate[] {
  intent = applyTwinIntent(intent, twin)
  const weights = { ...rankingWeightsSchema.parse(configured) }
  const prefs = twin.effective
  const sellerImportance = intent.preferences.reputableSeller === undefined ? prefs.sellerReputationImportance : intent.preferences.reputableSeller ? 'high' : 'low'
  weights.sellerTrust *= sellerImportance === 'high' ? 1.5 : sellerImportance === 'low' ? 0.5 : 1
  const priceSensitivity = intent.preferences.priceSensitivity ?? prefs.priceSensitivity
  weights.budgetMatch *= priceSensitivity === 'high' ? 1.4 : priceSensitivity === 'low' ? 0.7 : 1
  if (sellerImportance === 'high') weights.budgetMatch *= 0.8
  const sum = Object.values(weights).reduce((a, b) => a + b, 0)
  if (!Number.isFinite(sum) || sum <= 0) throw new Error('Ranking weights must have a positive finite sum')
  const researched = items.map(item => ({ item, verification: verifyCandidate(item, intent, rates) }))
  comparePrices(researched)
  const verified = researched.filter(({ verification: v }) => !v.hardViolations.length && !v.unmetRequirements.length)
  return verified.map(({ item, verification: v }) => {
    const reasons: string[] = [], preferenceReasons: string[] = []
    if (item.kind === 'nft' && intent.collectionSymbol && item.collectionSymbol === intent.collectionSymbol) reasons.push('The listing was returned for your requested collection symbol; collection authenticity still needs review.')
    else if (v.productMatch >= 70) reasons.push('The retrieved listing matches your product terms and required characteristics.')
    else reasons.push('The listing title partially matches your search terms.')
    if (v.budget === 'WITHIN') reasons.push(v.effectivePrice === undefined ? 'Its known costs fit your budget; the final total remains UNKNOWN.' : 'Its verified effective price fits your budget.')
    else reasons.push(v.budget === 'UNKNOWN' ? 'The available data cannot confirm whether it fits your budget.' : 'You did not set a price limit.')
    reasons.push(v.seller.score >= 60 ? 'The source supplies several positive seller signals.' : 'Seller trust remains uncertain because the available evidence is limited.')
    reasons.push(v.priceAssessment === 'UNKNOWN' ? 'Equivalent price evidence is insufficient to classify its market value.' : `Its ${v.priceBasis.toLowerCase()} price is ${v.priceAssessment.toLowerCase()} against ${v.comparedOffers} equivalent offers.`)
    let budget = v.budget === 'WITHIN' ? 1 : v.budget === 'NOT_SET' ? 0.5 : 0
    if (v.budget === 'WITHIN' && intent.maxPrice && v.knownPayablePrice !== undefined) budget = 0.75 + 0.25 * (1 - v.knownPayablePrice / intent.maxPrice)
    if (v.priceAssessment === 'VERY LOW') budget = 0 // anomalous price earns no value bonus
    const requestedAuthentic = intent.preferences.authentic ?? prefs.authentic
    const matches: number[] = []
    if (requestedAuthentic) matches.push(v.authenticity === 'VERIFIED' ? 1 : v.authenticity === 'HIGH CONFIDENCE' ? 0.8 : 0)
    if (intent.preferences.reputableSeller || sellerImportance === 'high') matches.push(v.seller.score / 100)
    if (intent.preferences.condition) matches.push(normalized(item.condition ?? '') === normalized(intent.preferences.condition) ? 1 : 0)
    if (intent.preferences.shippingCountry) matches.push(item.signals.shippingCountries?.includes(intent.preferences.shippingCountry) ? 1 : 0)
    const history = twin.history.filter(d => d.item.mode === item.mode && d.item.source === item.source
      && !!item.seller?.name && d.item.seller?.name === item.seller.name)
    const historyMatch = history.length ? history.filter(d => d.outcome === 'approve').length / history.length : 0.5
    if (history.length) preferenceReasons.push(`Your history includes ${history.length} decision(s) about this source/seller.`)
    if (sellerImportance === 'high') preferenceReasons.push(intent.preferences.reputableSeller ? 'Your current request gives seller reputation extra weight.' : 'Your Commerce Twin gives seller reputation extra weight.')
    if (priceSensitivity === 'high') preferenceReasons.push('Your current preferences give price extra weight.')
    if (prefs.preferredBrands?.length) matches.push(prefs.preferredBrands.some(brand => normalized(brand) === normalized(item.brand ?? '')) ? 1 : 0)
    if (prefs.preferredStores?.length) matches.push(prefs.preferredStores.some(store => normalized(store) === normalized(item.seller?.name ?? '')) ? 1 : 0)
    const premium = trustedSellerPremium({ item, verification: v }, verified)
    if (premium !== undefined && premium <= (prefs.acceptHigherPriceForTrustedSeller ?? 0) + 1e-8 && v.seller.score >= 60) {
      matches.push(1); preferenceReasons.push('A stronger seller is available within your preferred price premium. Your maximum budget still applies.')
    }
    if (history.length) matches.push(historyMatch)
    const factors = { productMatch: v.productMatch / 100, budgetMatch: budget, sellerTrust: v.seller.score / 100,
      productEvidence: v.productEvidenceScore / 100, websiteTrust: v.website.score / 100,
      preferenceMatch: matches.length ? matches.reduce((a, b) => a + b, 0) / matches.length : 0.5 }
    const scoreBreakdown = Object.fromEntries(Object.entries(factors).map(([key, value]) => [key, Math.round(value * weights[key as keyof RankingWeights] / sum * 10000) / 100])) as RankingWeights
    const totalScore = Math.min(100, Math.round(Object.values(scoreBreakdown).reduce((a, b) => a + b, 0) * 100) / 100)
    return { item, verification: v, totalScore, scoreBreakdown, reasons, preferenceReasons, explanation: reasons.join(' ') }
  }).sort((a, b) => b.totalScore - a.totalScore || a.item.id.localeCompare(b.item.id))
}
