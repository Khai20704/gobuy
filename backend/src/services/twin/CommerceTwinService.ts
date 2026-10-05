import { commerceTwinSchema, type CommerceDecision, type CommerceTwin, type TwinPreferences } from '@gobuy/shared'

export function deriveTwin(explicit: TwinPreferences = {}, history: CommerceDecision[] = []): CommerceTwin {
  const learned: TwinPreferences = {}
  const learningReasons: string[] = []
  // Demo clicks remain inspectable but cannot train preferences for real purchases.
  const real = history.filter(decision => decision.item.mode === 'real')
  if (real.filter(d => d.outcome === 'reject' && d.reason === 'Too expensive').length >= 3) {
    learned.priceSensitivity = 'high'; learningReasons.push('Three or more real-item rejections for price increased price sensitivity.')
  }
  if (real.filter(d => (d.outcome === 'approve' && d.trustScore >= 60) || (d.outcome === 'reject' && d.reason === 'Seller not trusted')).length >= 3) {
    learned.sellerReputationImportance = 'high'; learningReasons.push('At least three seller-related decisions increased seller reputation importance.')
  }
  const premiums = real.filter(d => d.outcome === 'approve' && d.trustedPricePremium !== undefined).map(d => d.trustedPricePremium!)
  if (premiums.length >= 3) {
    learned.acceptHigherPriceForTrustedSeller = Math.round(Math.min(0.05, premiums.reduce((sum, value) => sum + value, 0) / premiums.length) * 1000) / 1000
    learningReasons.push('At least three approvals chose a stronger seller within a 5% premium over a comparable cheaper option.')
  }
  return commerceTwinSchema.parse({ explicit, learned, history,
    effective: { sellerReputationImportance: 'medium', priceSensitivity: 'medium', acceptHigherPriceForTrustedSeller: 0, ...learned, ...explicit },
    learningReasons, autonomyBoundaries: { requiresUserApproval: true, purchasesEnabled: false, authority: 'existing-signed-mandate' } })
}
