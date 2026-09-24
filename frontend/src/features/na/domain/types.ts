export type Mandate = { limit: number; requireVerified: boolean; autonomy: boolean; version: number }
export type Proposal = { id: string; title: string; amount: number; verified: boolean }
export type Check = { label: string; detail: string; passed: boolean }
export type RecordItem = { id: string; title: string; approved: boolean; version: number; time: string }
export type Message = { id: string; text: string; image?: string }
export function evaluate(proposal: Proposal, mandate: Mandate): Check[] {
  return [
    { label: 'Budget boundary', detail: `${proposal.amount} / ${mandate.limit} demo units`, passed: proposal.amount <= mandate.limit },
    { label: 'Source evidence', detail: proposal.verified ? 'Verified fixture' : 'Evidence missing', passed: !mandate.requireVerified || proposal.verified },
    { label: 'Autonomous authorization', detail: mandate.autonomy ? 'Enabled' : 'Disabled', passed: mandate.autonomy },
  ]
}
