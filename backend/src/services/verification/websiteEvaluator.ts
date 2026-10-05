import type { CandidateItem, Verification } from '@gobuy/shared'
import { hasEvidence } from './evidence.js'

export function evaluateWebsite(item: CandidateItem): Verification['website'] {
  const reasons: string[] = [], missingSignals: string[] = []
  const website = item.signals.website
  let score = 0, independent = false
  const weights = { businessIdentity: 15, contact: 10, returnPolicy: 15, paymentMethods: 10,
    independentReputation: 20, authorizedRetailer: 20, buyerProtection: 10 }
  for (const [key, weight] of Object.entries(weights)) {
    const field = key as keyof typeof weights
    const value = website?.[field]
    const external = field === 'independentReputation' || field === 'authorizedRetailer' || field === 'buyerProtection'
    if (value === undefined || !hasEvidence(item, `website.${field}`, external)) { missingSignals.push(field); continue }
    reasons.push(`Retrieved ${field}: ${Array.isArray(value) ? value.join(', ') : value}.`)
    if (value && value !== 'negative' && (!Array.isArray(value) || value.length)) score += weight
    if (external && (value === true || value === 'positive')) independent = true
  }
  reasons.push('HTTPS alone does not establish business identity or trust.')
  const negative = (website?.independentReputation === 'negative' && hasEvidence(item, 'website.independentReputation', true))
    || (website?.suspiciousClaims === true && hasEvidence(item, 'website.suspiciousClaims'))
  if (negative) reasons.push('Retrieved evidence identifies a reputation or misleading-claims concern.')
  const status = negative ? 'LOW CONFIDENCE' : independent && score >= 70 ? 'HIGH CONFIDENCE'
    : independent && score >= 40 ? 'MEDIUM CONFIDENCE' : 'UNKNOWN'
  return { status, score: status === 'UNKNOWN' || negative ? 0 : score, reasons, missingSignals }
}
