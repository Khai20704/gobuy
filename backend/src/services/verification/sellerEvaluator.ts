import type { CandidateItem, SellerEvaluation } from '@gobuy/shared'
import { hasEvidence } from './evidence.js'

export function evaluateSeller(item: CandidateItem): SellerEvaluation {
  let score = 0
  const reasons: string[] = [], missingSignals: string[] = []
  const seller = item.seller
  if (seller?.rating !== undefined && seller.ratingScale && hasEvidence(item, 'seller.rating')) {
    const fraction = seller.rating / (seller.ratingScale === 'five-star' ? 5 : 100)
    score += Math.max(0, Math.min(1, fraction)) * 40
    reasons.push(`Source seller rating: ${seller.rating}${seller.ratingScale === 'percent' ? '%' : '/5'}.`)
  } else missingSignals.push('Seller rating')
  if (seller?.reviewCount !== undefined && hasEvidence(item, 'seller.reviewCount')) {
    score += Math.min(1, Math.log10(seller.reviewCount + 1) / 3) * 20
    reasons.push(`Source reports ${seller.reviewCount} seller reviews.`)
  } else {
    missingSignals.push('Seller review count')
    if (seller?.feedbackScore !== undefined && hasEvidence(item, 'seller.feedbackScore')) {
      score += Math.min(1, Math.log10(Math.max(0, seller.feedbackScore) + 1) / 3) * 10
      reasons.push(`Net feedback score ${seller.feedbackScore} contributes up to 10 points; it is not a review count.`)
    }
  }
  if (seller?.verified === undefined || !hasEvidence(item, 'seller.verified', true)) missingSignals.push('Verified seller status')
  else { if (seller.verified) score += 20; reasons.push(seller.verified ? 'Source marks the seller verified.' : 'Source does not mark the seller verified.') }
  if (item.signals.returnsAccepted === undefined || !hasEvidence(item, 'signals.returnsAccepted')) missingSignals.push('Return policy')
  else { if (item.signals.returnsAccepted) score += 10; reasons.push(item.signals.returnsAccepted ? 'Source indicates returns accepted.' : 'Source indicates no returns.') }
  if (seller?.historyYears === undefined || !hasEvidence(item, 'seller.historyYears')) missingSignals.push('Store history')
  else { score += Math.min(1, seller.historyYears / 5) * 10; reasons.push(`Source reports ${seller.historyYears} years of store history.`) }
  return { score: Math.round(score), reasons, missingSignals }
}
