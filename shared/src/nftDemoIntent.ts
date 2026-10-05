export const normalizeNftRequest = (text: string) => text.toLowerCase().normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').trim()

// Explicit requests only; a question, negation or conditional does not authorize a purchase.
export function isNftDemoPurchaseRequest(text: string): boolean {
  const value = normalizeNftRequest(text)
  if (/\b(?:not|don't|never|khong|dung|chua|neu|if)\b/.test(value) || value.includes('?')) return false
  return /^(?:(?:na|please|lam on)\s*[,!:]?\s*)*(?:(?:(?:tui|toi|minh|to|em|anh|chi)\s+(?:can|muon)|i\s+(?:want|need)\s+to)\s+)?(?:mua|buy|purchase)\b/.test(value)
    && /\bnft\b/.test(value)
}
