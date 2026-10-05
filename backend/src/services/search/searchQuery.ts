import type { SearchIntent } from '@gobuy/shared'

// Search for the product identity. Budgets and trust requirements are checked
// against retrieved evidence, not repeated as noisy search keywords.
export function productSearchQuery(intent: SearchIntent): string {
  const terms = [intent.product, ...intent.keywords, intent.brand, intent.model, intent.size]
  const seen = new Set<string>()
  return terms.flatMap(term => (term ?? '').split(/\s+/)).filter(term => {
    const key = term.toLowerCase()
    if (!key || seen.has(key)) return false
    seen.add(key)
    return true
  }).join(' ').slice(0, 400)
}
