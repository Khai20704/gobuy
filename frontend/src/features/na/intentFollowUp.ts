const solBudget = /(?:\b(?:duoi|under|below|toi da|maximum|max|budget|ngan sach|khoang|tam|around|about)\s*)?\b\d+(?:[.,]\d{1,9})?\s*sol\b/i
const budgetWords = new Set(['duoi', 'under', 'below', 'toi', 'da', 'maximum', 'max', 'budget', 'ngan', 'sach', 'khoang', 'tam', 'around', 'about', 'sol', 'cho', 'tui', 'minh', 'nha', 'nhe', 'thoi'])

export function hasSolBudget(text: string) {
  return solBudget.test(text)
}

export function isCollectionPriceDiscovery(text: string) {
  const value = text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/đ/g, 'd')
  return /\b(collections?|bo suu tap)\b/.test(value)
    && /\b(re nhat|gia thap nhat|cheapest|lowest price|dat nhat|gia cao nhat|most expensive|highest price)\b/.test(value)
}

export function isBudgetOnlyReply(text: string) {
  const match = solBudget.exec(text)
  if (!match) return false
  const remaining = text.replace(match[0], '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  const terms = remaining.match(/[a-z0-9]+/g) ?? []
  return terms.every(term => budgetWords.has(term))
}

export function isPurchaseIntent(text: string) {
  return /\b(?:nft|tranh|art|artwork|mua|buy|purchase|tim|find|collection|bo suu tap)\b/i.test(
    text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd'),
  )
}
