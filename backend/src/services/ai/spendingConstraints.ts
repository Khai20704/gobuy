import { InputError } from '../../schemas/search.js'

function amount(raw: string, currency?: string): number {
  const suffix = raw.match(/(million|triệu|trieu|k|m)$/i)?.[1].toLowerCase()
  let numeric = raw.replace(/\s*(million|triệu|trieu|k|m)$/i, '')
  // A single thousands/decimal separator is ambiguous for SOL: fail closed.
  if (currency === 'SOL' && /^\d{1,3}[,.]\d{3}$/.test(numeric)) throw new InputError('Use an unambiguous SOL maximum, such as 1 SOL or 1.25 SOL.')
  if (/^\d{1,3}([,.]\d{3})+$/.test(numeric)) numeric = numeric.replace(/[,.]/g, '')
  else numeric = numeric.replace(',', '.')
  const value = Number(numeric) * (suffix === 'k' ? 1000 : suffix ? 1_000_000 : 1)
  if (!Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) throw new InputError('Use a valid numeric maximum budget.')
  return value
}

// Spending authority is derived from explicit text, never from model output or Twin preferences.
// Unsupported/ambiguous phrasing yields no authorization; Na can request an explicit numeric limit.
export function explicitSpendingConstraints(text: string) {
  const currencies = [...new Set(text.match(/\b(?:SOL|USDC|USD|VND|EUR|GBP)\b/gi)?.map(value => value.toUpperCase()) ?? [])]
  if (/\$/.test(text)) currencies.push('USD')
  if (/€/.test(text)) currencies.push('EUR')
  if (/£/.test(text)) currencies.push('GBP')
  if (/₫|đồng|triệu/i.test(text)) currencies.push('VND')
  const currencySet = [...new Set(currencies)]
  const currency = currencySet.length === 1 ? currencySet[0] : undefined
  const pattern = /(?:\b(?:under|below|up to|at most|maximum|max|budget)|dưới|duoi|tối đa|toi da)\s*(?:(?:of|is|to)\s*)?[:=]?\s*[$€£₫]?\s*(\d[\d,.]*(?:\s*(?:million|triệu|trieu|k|m)\b)?)(?![\p{L}\d.,+\/-])/giu
  const maxima = [...text.matchAll(pattern)].map(match => amount(match[1].replace(/[.,]$/, ''), currency))
  const quantityText = text.match(/\b(?:quantity|qty)\s*[:=]?\s*(\d+)/i)?.[1]
    ?? text.match(/\b(?:buy|purchase|order|mua)(?:\s+me)?\s+(\d+)\s+(?!sol\b|usd\b|vnd\b|eur\b|gbp\b)/i)?.[1]
  const quantity = quantityText === undefined ? 1 : Number(quantityText)
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100) throw new InputError('Use a purchase quantity between 1 and 100.')
  return { maximum: maxima.length ? Math.min(...maxima) : undefined, currency, quantity }
}
