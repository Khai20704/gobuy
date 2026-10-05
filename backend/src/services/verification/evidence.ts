import type { CandidateItem } from '@gobuy/shared'

export function hasEvidence(item: CandidateItem, field: string, verified = false): boolean {
  return item.mode === 'mock' || !!item.evidence?.some(e => e.field === field && (!verified || e.kind === 'VERIFIED_FACT'))
}

// Called only by trusted adapters after parsing a retrieved response. A source statement
// records what the source reports; it does not authenticate the seller or the product.
export function recordSourceEvidence(item: CandidateItem): CandidateItem {
  const evidence: NonNullable<CandidateItem['evidence']> = []
  const add = (field: string, value: unknown) => {
    if (value !== undefined) evidence.push({ field, statement: JSON.stringify(value).slice(0, 1200),
      reference: item.productUrl, retrievedAt: item.fetchedAt, kind: 'SOURCE_CLAIM' })
  }
  for (const field of ['title', 'price', 'currency', 'brand', 'model', 'size', 'compatibleWith', 'condition', 'stockStatus', 'purchaseCount', 'productRating', 'productReviewCount'] as const) add(field, item[field])
  for (const [key, value] of Object.entries(item.seller ?? {})) add(`seller.${key}`, value)
  for (const [key, value] of Object.entries(item.costs ?? {})) add(`costs.${key}`, value)
  for (const [key, value] of Object.entries(item.signals)) if (key !== 'authenticity' && key !== 'website') add(`signals.${key}`, value)
  return { ...item, evidence }
}
