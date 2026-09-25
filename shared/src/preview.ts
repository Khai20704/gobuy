import { RULES, REASONS, type CommerceProposal, type Mandate, type RuleCheck } from './contracts.js'

// Presentation only. Never a source of on-chain authorization.
export function previewRules(p: CommerceProposal, m: Mandate, version = m.version, now = Math.floor(Date.now() / 1000)): RuleCheck[] {
  const values = [version === m.version, p.expiresAt > now, m.autonomy,
    BigInt(p.amount) <= BigInt(m.maxAmount), p.currency === 'DEVNET_SOL_LAMPORTS',
    p.assetType === m.assetType, p.marketplace === m.marketplace,
    !m.requireVerifiedSeller || p.sellerEvidence.claimedVerified, p.assetType !== 'RWA']
  return RULES.map((label, index) => ({ label, passed: values[index] }))
}
export function previewReason(checks: RuleCheck[]) {
  const failed = checks.findIndex(check => !check.passed)
  return REASONS[failed + 1]
}
export const recordedRules = (mask: number): RuleCheck[] => RULES.map((label, index) => ({ label, passed: !!(mask & (1 << index)) }))
