import { rwaRecommendationSchema, type RWAAsset, type RWARecommendation } from '@gobuy/shared'
import { normalizeIntentText } from '../acquisition/intentLanguage.js'
import { detectRWACategory, type RWACategoryHint } from './RWAIntent.js'

/**
 * Category discovery over the approved list.
 *
 * TRUST RULE: RWA_APPROVED_LIST is the ONLY identity allowlist. Only rows that are `verified` and
 * `allowedForSwap` are ever considered here. Market price, and the ranking built on it, only order
 * candidates that are already approved; they can never add, promote or reject an identity.
 */

/** The already-approved candidates. Anything not verified AND allowed to swap is not a candidate. */
export function approvedCandidates(assets: RWAAsset[]): RWAAsset[] {
  return assets.filter(asset => asset.verified && asset.allowedForSwap)
}

/** Reads a free-form category label into the same hint shape the intent parser uses. */
function hintFor(label: string): RWACategoryHint {
  const named = detectRWACategory(label)
  if (named) return named
  const keyword = normalizeIntentText(label).replace(/[^a-z0-9]+/g, ' ').trim()
  return { label: label.toUpperCase(), keywords: keyword ? [keyword] : [] }
}

/** True when an already-approved asset belongs to the requested category, judged by its metadata. */
export function matchesCategory(asset: RWAAsset, hint: RWACategoryHint): boolean {
  const padded = ' ' + normalizeIntentText(`${asset.symbol} ${asset.name} ${asset.underlying}`).replace(/[^a-z0-9]+/g, ' ') + ' '
  if (hint.keywords.some(keyword => padded.includes(' ' + keyword + ' '))) return true
  // A closed category (GOLD, TREASURY, ETF, COMMODITY) maps straight onto the asset's own category.
  // TECHNOLOGY deliberately has no closed subtype: a technology xStock is stored as EQUITY, so it is
  // matched by metadata only and never inflates the set with unrelated equities.
  return hint.subtype !== undefined && asset.category === hint.subtype
}

/** Approved candidates in the requested category. With no category, every approved candidate. */
export function filterApprovedByCategory(assets: RWAAsset[], category?: string): RWAAsset[] {
  const approved = approvedCandidates(assets)
  if (!category) return approved
  const hint = hintFor(category)
  return approved.filter(asset => matchesCategory(asset, hint))
}

export interface PricedCandidate { asset: RWAAsset; priceUsd: number | null }

/** A cheaper already-approved candidate ranks higher on this factor; it is never authenticity. */
function priceScore(priceUsd: number | null): number {
  if (priceUsd === null) return 0
  return Math.max(0, 40 * (1 - Math.min(1, priceUsd / 1000)))
}

function toRecommendation(candidate: PricedCandidate, budgetUsd: number | undefined): RWARecommendation {
  const { asset, priceUsd } = candidate
  const withinBudget = budgetUsd === undefined || priceUsd === null ? null : priceUsd <= budgetUsd
  const reasons = ['Identity comes from RWA_APPROVED_LIST (approved canonical mint), never from liquidity, volume or popularity.']
  reasons.push(priceUsd === null
    ? 'Indicative market price is unavailable, so budget fit is unconfirmed.'
    : `Indicative market price ≈ ${priceUsd} USD per ${asset.symbol} (market data only).`)
  if (budgetUsd !== undefined && withinBudget !== null) reasons.push(withinBudget
    ? `Fits the ≈${budgetUsd} USDC budget.` : `Price is above the ≈${budgetUsd} USDC budget.`)
  const score = Math.round(Math.min(100, (withinBudget === true ? 60 : withinBudget === null ? 30 : 0) + priceScore(priceUsd)) * 100) / 100
  return rwaRecommendationSchema.parse({ symbol: asset.symbol, mint: asset.mint, name: asset.name,
    category: asset.category, priceUsd, withinBudget, score, reasons })
}

/**
 * Filters candidates by an applicable budget, then ranks the survivors.
 *
 * A budget only filters when its currency is USDC, because that is the only currency the USDC-quoted
 * price can be compared against without inventing a conversion rate. A candidate whose price is
 * unknown is kept, flagged as budget-unconfirmed. Equal scores fall back to a stable symbol order.
 */
export function rankApprovedCandidates(candidates: PricedCandidate[], budget?: { amount: number; currency: 'SOL' | 'USDC' }): RWARecommendation[] {
  const budgetUsd = budget && budget.currency === 'USDC' && budget.amount > 0 ? budget.amount : undefined
  return candidates
    .filter(candidate => budgetUsd === undefined || candidate.priceUsd === null || candidate.priceUsd <= budgetUsd)
    .map(candidate => toRecommendation(candidate, budgetUsd))
    .sort((a, b) => b.score - a.score || a.symbol.localeCompare(b.symbol))
}
