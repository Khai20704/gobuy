import type { CandidateItem, Verification } from '@gobuy/shared'
import { normalized } from './verifyCandidates.js'
import { hasEvidence } from './evidence.js'

type Offer = { item: CandidateItem; verification: Verification }

export function equivalentOffers(a: CandidateItem, b: CandidateItem): boolean {
  // A shared query is not proof of equivalent variants, condition, or models.
  return a.mode === b.mode && a.kind === b.kind && a.currency === b.currency
    && !!a.brand && !!a.model && !!a.condition && !!b.brand && !!b.model && !!b.condition
    && normalized(a.brand) === normalized(b.brand) && normalized(a.model) === normalized(b.model)
    && normalized(a.condition) === normalized(b.condition) && normalized(a.size ?? '') === normalized(b.size ?? '')
    && JSON.stringify(a.compatibleWith ?? []) === JSON.stringify(b.compatibleWith ?? [])
}

function comparableAmounts(a: Offer, b: Offer): [number, number] | undefined {
  if (!equivalentOffers(a.item, b.item) || !hasEvidence(a.item, 'price') || !hasEvidence(b.item, 'price')) return undefined
  const first = a.verification.effectivePrice, second = b.verification.effectivePrice
  if (first !== undefined && second !== undefined && a.item.costs?.shippingCountry === b.item.costs?.shippingCountry) return [first, second]
  if (first === undefined && second === undefined && a.item.price !== undefined && b.item.price !== undefined) return [a.item.price, b.item.price]
  return undefined // Never compare a checkout total with a bare item price or a different destination.
}

export function trustedSellerPremium(selected: Offer, candidates: Offer[]): number | undefined {
  const comparisons = candidates.flatMap(other => {
    const amounts = comparableAmounts(selected, other)
    return amounts && other.verification.productMatch >= 70 && other.verification.seller.score < selected.verification.seller.score
      && amounts[1] > 0 && amounts[1] < amounts[0] ? [amounts] : []
  }).sort((a, b) => a[1] - b[1])
  return comparisons.length ? comparisons[0][0] / comparisons[0][1] - 1 : undefined
}

export function comparePrices(rows: Offer[]): void {
  for (const row of rows) {
    const { item, verification: v } = row
    const effective = v.effectivePrice !== undefined
    const amount = effective ? v.effectivePrice : item.price
    if (amount === undefined || !item.currency) continue
    const prices = rows.flatMap(other => {
      const amounts = other !== row && !other.verification.hardViolations.length ? comparableAmounts(row, other) : undefined
      return amounts && amounts[1] > 0 ? [amounts[1]] : []
    }).sort((a, b) => a - b)
    // Two competing offers are required; one anomalous peer cannot establish market value.
    if (prices.length < 2) continue
    const median = (prices[Math.floor((prices.length - 1) / 2)] + prices[Math.floor(prices.length / 2)]) / 2
    const ratio = amount / median
    v.priceAssessment = ratio < 0.6 ? 'VERY LOW' : ratio <= 0.95 ? 'COMPETITIVE' : ratio <= 1.15 ? 'NORMAL' : 'EXPENSIVE'
    v.priceBasis = effective ? 'EFFECTIVE' : 'LISTED'; v.comparedOffers = prices.length
    v.signals.push(`Price comparison uses ${prices.length} equivalent offers in ${effective ? v.assessmentCurrency ?? item.currency : item.currency}, on ${v.priceBasis.toLowerCase()} price only.`)
    if (!effective) v.warnings.push('Market price comparison excludes unknown delivery costs and required fees.')
    if (v.priceAssessment === 'VERY LOW') v.warnings.push('Price is unusually low versus equivalent offers. This increases uncertainty; price alone does not prove authenticity or fraud.')
  }
}
