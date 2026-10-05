import type { CandidateItem, ExchangeRate, SearchIntent, Verification } from '@gobuy/shared'
import { evaluateSeller } from './sellerEvaluator.js'
import { evaluateWebsite } from './websiteEvaluator.js'
import { hasEvidence } from './evidence.js'
import { convertMoney, freshRate, sumMoney } from '../currency/SolExchangeRates.js'

export const normalized = (value: string) => value.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^\p{L}\p{N}]/gu, '')
const titleContains = (title: string, value: string) => {
  const words = title.toLowerCase().match(/[\p{L}\p{N}]+(?:[-./][\p{L}\p{N}]+)*/gu) ?? []
  return value.split(/\s+/).map(normalized).every(word => words.some(token => normalized(token) === word))
}

export function verifyCandidate(item: CandidateItem, intent: SearchIntent, rates: ExchangeRate[] = []): Verification {
  const signals: string[] = [], warnings: string[] = [], hardViolations: string[] = [], unmetRequirements: string[] = []
  const evidencedPrice = item.price !== undefined && hasEvidence(item, 'price') && hasEvidence(item, 'currency')
  const costs = item.costs
  const quantity = intent.quantity ?? 1
  const costContext = costs?.currency === item.currency && (costs?.quantity ?? 1) === quantity
    && (!intent.preferences.shippingCountry || costs?.shippingCountry === intent.preferences.shippingCountry)
  const shipping = costContext && hasEvidence(item, 'costs.shipping') ? costs?.shipping : undefined
  const fees = costContext && hasEvidence(item, 'costs.requiredFees') ? costs?.requiredFees : undefined
  const assessmentCurrency = intent.currency ?? item.currency
  const rawKnown = evidencedPrice ? sumMoney([...Array<number>(quantity).fill(item.price!), shipping ?? 0, fees ?? 0]) : undefined
  const knownPayablePrice = rawKnown !== undefined && item.currency && assessmentCurrency ? convertMoney(rawKnown, item.currency, assessmentCurrency, rates) : undefined
  const effectivePrice = evidencedPrice && shipping !== undefined && fees !== undefined ? knownPayablePrice : undefined
  const exchangeRate = item.currency !== assessmentCurrency ? freshRate(rates, item.currency === 'SOL' ? assessmentCurrency ?? '' : item.currency ?? '') : undefined
  if (exchangeRate) signals.push(`Current conversion: 1 SOL = ${exchangeRate.rate} ${exchangeRate.quoteCurrency}, observed ${exchangeRate.observedAt}. Conversion is refreshed before payment.`)
  const hasBudget = intent.minPrice !== undefined || intent.maxPrice !== undefined
  const comparable = knownPayablePrice !== undefined && intent.currency !== undefined
  const budget = !hasBudget ? 'NOT_SET' : !comparable ? 'UNKNOWN'
    : (intent.maxPrice !== undefined && knownPayablePrice! > intent.maxPrice)
      || (intent.minPrice !== undefined && knownPayablePrice! < intent.minPrice) ? 'OUTSIDE' : 'WITHIN'
  if (budget === 'OUTSIDE') hardViolations.push('Known price and required costs violate your price range.')
  if (budget === 'UNKNOWN') unmetRequirements.push('Budget cannot be verified: missing price/currency or a different currency. No exchange rate is assumed.')
  if (!evidencedPrice || !item.currency) unmetRequirements.push('A retrieved offer price and currency are required for selection.')
  if (effectivePrice === undefined) warnings.push('Effective price is UNKNOWN: shipping or required fees are not fully verified. The listed price is not a confirmed checkout total.')
  if (intent.action === 'BUY') {
    if (intent.maxPrice === undefined || !intent.currency) unmetRequirements.push('A current maximum budget and currency are required before a purchase.')
    if (effectivePrice === undefined) unmetRequirements.push('Final effective cost must be verified before purchase; unknown fees cannot be assumed to be zero.')
    if (!['IN_STOCK', 'LIMITED_STOCK'].includes(item.stockStatus ?? '') || !hasEvidence(item, 'stockStatus')) unmetRequirements.push('Live stock evidence is required before purchase.')
  }
  if (budget === 'WITHIN') signals.push(effectivePrice === undefined ? 'Known costs fit the budget; the final payable total remains UNKNOWN.' : 'Verified effective price fits the budget.')
  const collectionMatch = item.kind === 'nft' && !!intent.collectionSymbol && item.collectionSymbol === intent.collectionSymbol
  const productMatch = collectionMatch ? 100 : Math.round(intent.keywords.filter(word => titleContains(item.title, word)).length / intent.keywords.length * 100)
  if (collectionMatch) signals.push('The collection endpoint matches the requested symbol; this is not collection authentication.')
  if (intent.collectionSymbol && !collectionMatch) hardViolations.push('Wrong collection or asset type.')
  for (const key of ['brand', 'model', 'size'] as const) {
    const requested = intent[key]
    if (!requested) continue
    const supplied = item[key]
    if (supplied && hasEvidence(item, key) && normalized(supplied) !== normalized(requested)) hardViolations.push(`Source ${key} conflicts with your requested ${key}.`)
    else if ((supplied && hasEvidence(item, key) && normalized(supplied) === normalized(requested)) || (key !== 'size' && titleContains(item.title, requested))) signals.push(`Source text matches requested ${key}; this is a source claim, not authentication.`)
    else unmetRequirements.push(`Requested ${key} is not established by the source.`)
  }
  if (productMatch < 70) unmetRequirements.push('Insufficient product match to select this listing.')
  const evidence = item.signals.authenticity
  const conflict = evidence?.status === 'CONFLICTING' && evidence.basis !== 'listing-claim'
  const authenticity: Verification['authenticity'] = item.mode === 'mock' || !evidence || evidence.basis === 'listing-claim' || evidence.status === 'CONFLICTING' ? 'UNKNOWN' : evidence.status
  if (conflict) hardViolations.push('Authenticity evidence conflicts with the listing.')
  if (authenticity === 'UNKNOWN') warnings.push('Authenticity UNKNOWN: no reliable platform/manufacturer attestation. Seller wording and price are not proof.')
  else signals.push(`Authenticity ${authenticity}: ${evidence!.note}`)
  if (intent.preferences.authentic && !['VERIFIED', 'HIGH CONFIDENCE'].includes(authenticity)) unmetRequirements.push('The authenticity requirement lacks strong verifiable evidence.')
  if (item.kind === 'nft') {
    if (!item.nft?.mint || !item.nft.seller || item.nft.listingStatus !== 'LISTED') unmetRequirements.push('NFT mint, seller and active listing evidence are required.')
    if (!item.nft?.collectionAddress) unmetRequirements.push('Collection address is UNKNOWN; a collection symbol is not on-chain collection verification.')
  }
  if (item.kind === 'rwa') {
    if (!item.rwa || item.rwa.network !== 'Solana' || Date.now() - Date.parse(item.rwa.observedAt) > 86400000) unmetRequirements.push('Current protocol, token, Solana network and risk metadata are required.')
    if (intent.preferences.riskLevel !== undefined && item.rwa && item.rwa.riskLevel > intent.preferences.riskLevel) hardViolations.push('Protocol risk metadata exceeds the requested risk level.')
    if (intent.action === 'BUY') unmetRequirements.push('RWA execution is not supported.')
    warnings.push(...(item.rwa?.risks ?? []), 'Yield is a source claim, not a guaranteed return. Eligibility and redemption restrictions require review.')
  }
  if (intent.category === 'rwa' && item.kind !== 'rwa') hardViolations.push('An RWA protocol result is required.')
  if (item.kind === 'web-page') unmetRequirements.push('Search discovery page has no verified product offer.')
  if (item.mode === 'mock') warnings.push('DEVELOPMENT FIXTURE: every product and seller field is synthetic.')
  if (item.stockStatus === 'OUT_OF_STOCK') hardViolations.push('The source reports this listing unavailable.')
  if (!item.stockStatus) warnings.push('Stock status is UNKNOWN.')
  if (intent.preferences.condition) {
    if (!item.condition || !hasEvidence(item, 'condition')) unmetRequirements.push('Required condition is UNKNOWN.')
    else if (normalized(item.condition) !== normalized(intent.preferences.condition)) hardViolations.push('Wrong condition.')
  }
  if (intent.compatibleWith) {
    if (!item.compatibleWith || !hasEvidence(item, 'compatibleWith')) unmetRequirements.push('Required compatibility is UNKNOWN.')
    else if (!item.compatibleWith.some(value => normalized(value) === normalized(intent.compatibleWith!))) hardViolations.push('Required compatibility is not supported.')
  }
  const destination = intent.preferences.shippingCountry
  if (destination) {
    if (item.signals.excludedShippingCountries?.includes(destination)) hardViolations.push('The seller excludes your shipping destination.')
    else if (!hasEvidence(item, 'signals.shippingCountries') || !item.signals.shippingCountries?.includes(destination)) unmetRequirements.push('Shipping to your destination is UNKNOWN.')
  }
  const seller = evaluateSeller(item)
  if (intent.preferences.minSellerTrust !== undefined && seller.score < intent.preferences.minSellerTrust) hardViolations.push('Seller evidence does not meet your minimum trust threshold.')
  const website = evaluateWebsite(item)
  if (website.status === 'LOW CONFIDENCE') hardViolations.push('Website or marketplace evidence reports a trust concern.')
  if (website.status === 'UNKNOWN') warnings.push('Website / marketplace trust is UNKNOWN; HTTPS and appearance are not proof.')
  if (item.purchaseCount === undefined) warnings.push('Purchase count is UNKNOWN; the source does not expose a verified count. It was not estimated.')
  const rating = hasEvidence(item, 'productRating') ? item.productRating : undefined
  const reviews = hasEvidence(item, 'productReviewCount') ? item.productReviewCount : undefined
  // Sparse ratings contribute less evidence, even when every rating is five stars.
  const reviewScore = rating !== undefined && reviews !== undefined ? (rating / 5) * (reviews / (reviews + 50)) * 70 : 0
  const productEvidenceScore = Math.round(reviewScore + (item.model && hasEvidence(item, 'model') ? 10 : 0)
    + (item.condition && hasEvidence(item, 'condition') ? 10 : 0) + (item.signals.warranty && hasEvidence(item, 'signals.warranty') ? 10 : 0))
  if (rating !== undefined) signals.push(`Source product rating ${rating}/5 across ${reviews ?? 'UNKNOWN'} reviews. Review text, recency and suspicious patterns are not established.`)
  const confidence = hardViolations.length || unmetRequirements.length ? 'LOW CONFIDENCE'
    : seller.score >= 60 && website.score >= 40 && effectivePrice !== undefined ? 'HIGH CONFIDENCE' : 'MEDIUM CONFIDENCE'
  return { budget, productMatch, authenticity, confidence, seller, signals, warnings, hardViolations, unmetRequirements, assessmentCurrency, exchangeRate,
    effectivePrice, knownPayablePrice, priceAssessment: 'UNKNOWN', priceBasis: 'UNKNOWN', comparedOffers: 0, productEvidenceScore, website }
}
