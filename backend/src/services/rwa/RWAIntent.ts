import { rwaIntentSchema, type RWAIntent, type RWAAsset, type RWACategory } from '@gobuy/shared'
import { InputError } from '../../schemas/search.js'
import { normalizeIntentText, searchOnlyRequest } from '../acquisition/intentLanguage.js'

/**
 * RWA intent parsing. Two order types are supported and they are NEVER interchangeable:
 *
 *  A) "Mua 100 USDC NVDAx khi giá dưới $175" -> order SPEND,   amount 100 USDC, condition < 175 USD
 *  B) "Mua 1 NVDAx dưới 1 SOL"               -> order QUANTITY, quantity 1, maxTotalSpend 1 SOL
 *
 * In A the number is money spent, not a quantity of the asset. In B the number is an exact quantity
 * and the SOL figure is a ceiling on the total cost, not an amount to spend.
 *
 * This parser only extracts. It never decides that a symbol is a real RWA: classification belongs to
 * `AssetResolver`, which requires an exact approved mint in RWA_APPROVED_LIST.
 */

const NUMBER = '(\\d+(?:[.,]\\d+)?)'
const COMPARISON = '(?:duoi|below|under|less than|khong qua|toi da|nho hon|<)'
const DECIMALS: Record<'SOL' | 'USDC', number> = { SOL: 9, USDC: 6 }

const STOPWORDS = new Set(['mua', 'buy', 'ban', 'sell', 'tim', 'find', 'cho', 'tui', 'toi', 'i', 'me', 'we',
  'rwa', 'nft', 'sol', 'usd', 'usdc', 'cua', 'of', 'the', 'a', 'an', 'va', 'and', 'khi', 'when', 'gia',
  'price', 'duoi', 'under', 'below', 'less', 'than', 'max', 'da', 'khong', 'qua', 'ngan', 'sach', 'budget',
  'dong', 'token', 'tokenized', 'stock', 'co', 'phieu', 'equity', 'etf', 'vang', 'gold', 'treasury',
  'commodity', 'hang', 'hoa', 'that', 'thuc', 'real', 'nai', 'dau', 'tu', 'invest', 'investment'])

function toUnits(value: string, currency: 'SOL' | 'USDC'): string {
  const [whole, fraction = ''] = value.replace(',', '.').split('.')
  if (fraction.length > DECIMALS[currency]) throw new InputError(`Số tiền ${currency} có tối đa ${DECIMALS[currency]} chữ số thập phân.`)
  const raw = BigInt(whole) * 10n ** BigInt(DECIMALS[currency]) + BigInt(fraction.padEnd(DECIMALS[currency], '0'))
  if (raw <= 0n || raw > 10000000000000n) throw new InputError('Số tiền RWA ngoài giới hạn cho phép.')
  return raw.toString()
}

const decimalsOf = (value: string) => value.replace(',', '.').split('.')[1]?.length ?? 0

/**
 * Approved registry symbols win. Otherwise an asset-shaped token is returned so an unapproved
 * look-alike (the fake "NVDAx") is classified and blocked instead of silently ignored.
 */
export function extractRWASymbol(text: string, assets: RWAAsset[]): string | undefined {
  const padded = ' ' + normalizeIntentText(text).replace(/[^a-z0-9]+/g, ' ') + ' '
  const approved = assets.find(asset => padded.includes(' ' + asset.symbol.toLowerCase() + ' '))
  if (approved) return approved.symbol
  const named = assets.filter(asset => padded.includes(' ' + normalizeIntentText(asset.name).replace(/[^a-z0-9]+/g, ' ').trim() + ' '))
  if (named.length === 1) return named[0].symbol
  const tokens = [...text.matchAll(/\b[A-Za-z]{2,10}[xX]\b/g), ...text.matchAll(/\b[A-Z]{3,6}\b/g)]
  const token = tokens.map(match => match[0]).find(token => !STOPWORDS.has(token.toLowerCase())
    && !['tech', 'chip', 'bond', 'bonds', 'stocks', 'silver', 'oil'].includes(token.toLowerCase()))
  if (!token) return undefined
  return token.slice(0, 24)
}

/** True when the wording itself is RWA-flavoured, or the text names an approved asset. */
export function isRWARequest(text: string, assets: RWAAsset[] = []): boolean {
  if (assets.some(asset => extractRWASymbol(text, assets)?.toLowerCase() === asset.symbol.toLowerCase())) return true
  return /\b(rwa|tokenized|token hoa|vang|gold|treasury|trai phieu|equity|co phieu|stock|etf|commodity|hang hoa)\b/.test(normalizeIntentText(text))
}

/**
 * A category the user may ask for instead of a named asset. `keywords` are matched against the
 * normalized text only to READ the request; they are never evidence that a token is a real RWA.
 * `subtype`, when present, is the closed RWA_APPROVED_LIST category the label maps onto. TECHNOLOGY
 * has no closed category (a technology xStock is stored as EQUITY), so it is matched by metadata.
 */
export interface RWACategoryHint { label: string; subtype?: RWACategory; keywords: string[] }
export const RWA_CATEGORY_HINTS: RWACategoryHint[] = [
  { label: 'TECHNOLOGY', keywords: ['technology', 'tech', 'cong nghe', 'semiconductor', 'software', 'chip',
    'nvidia', 'nvda', 'tesla', 'tsla', 'apple', 'aapl', 'microsoft', 'msft', 'amd', 'nasdaq'] },
  { label: 'EQUITY', subtype: 'EQUITY', keywords: ['equity', 'co phieu', 'stock', 'stocks'] },
  { label: 'GOLD', subtype: 'GOLD', keywords: ['gold', 'vang'] },
  { label: 'TREASURY', subtype: 'TREASURY', keywords: ['treasury', 'trai phieu', 'bond', 'bonds', 'usdy', 'ousg', 't-bill', 'tbill'] },
  { label: 'ETF', subtype: 'ETF', keywords: ['etf'] },
  { label: 'COMMODITY', subtype: 'COMMODITY', keywords: ['commodity', 'hang hoa', 'oil', 'silver'] },
]

/** Reads the category a request is about, if any. Returns undefined for a request with no theme. */
export function detectRWACategory(text: string): RWACategoryHint | undefined {
  const padded = ' ' + normalizeIntentText(text).replace(/[^a-z0-9]+/g, ' ') + ' '
  return RWA_CATEGORY_HINTS.find(hint => hint.keywords.some(keyword => padded.includes(' ' + keyword + ' ')))
}

export function parseRWAIntent(text: string, assets: RWAAsset[]): RWAIntent {
  const value = normalizeIntentText(text)
  if (/\b(electronics|dien tu)\b/.test(value)) throw new InputError('Electronics không được phép trong delegated-spending MVP NFT/RWA.')
  const hint = detectRWACategory(text)
  const subtype: RWACategory | undefined = hint?.subtype
  const symbol = extractRWASymbol(text, assets)
  const mints = text.match(/\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g) ?? []
  if (mints.length > 1 || /\b(nan|infinity)\b/.test(value)) throw new InputError('Nêu một số tiền dương và một asset RWA cụ thể.')
  // A request naming no symbol and no mint is a CATEGORY_DISCOVERY, never a specific asset. The raw
  // sentence is never used as an identifier, so "Tìm một RWA công nghệ" can never become a mint.
  const requestKind: RWAIntent['requestKind'] = symbol || mints[0] ? 'SPECIFIC_ASSET' : 'CATEGORY_DISCOVERY'

  // 1. Price trigger. Anchored on a price word ("giá"/"price") or on "$" after a comparison, so a
  //    bare "dưới 1 SOL" ceiling is NOT read as a price (see order B).
  const priceMatch = value.match(new RegExp('(?:gia|price)[^0-9$]{0,16}' + NUMBER))
    ?? value.match(new RegExp(COMPARISON + '\\s*\\$\\s*' + NUMBER))
  const targetPrice = priceMatch ? Number(priceMatch[1].replace(',', '.')) : undefined
  if (targetPrice !== undefined && (!Number.isFinite(targetPrice) || targetPrice <= 0)) throw new InputError('Giá mục tiêu không hợp lệ.')

  // 2. Exact quantity: a number bound directly to the asset symbol ("1 NVDAx").
  const symbolPattern = symbol ? symbol.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : undefined
  const quantityMatch = symbolPattern ? value.match(new RegExp(NUMBER + '\\s*' + symbolPattern + '\\b')) : null
  // 3. Order B's money ceiling: "<qty> ASSET ... duoi N SOL|USDC".
  const capMatch = quantityMatch ? value.match(new RegExp(COMPARISON + '\\s*' + NUMBER + '\\s*(usdc|sol)\\b')) : null
  // 4. Money to spend: "100 USDC" or a "$100" that is not the price trigger.
  const spendMatch = value.match(new RegExp(NUMBER + '\\s*(usdc|sol)\\b'))
  const priceDollarIndex = priceMatch && priceMatch[0].includes('$') ? priceMatch.index! + priceMatch[0].lastIndexOf('$') : -1
  const dollarSpend = [...value.matchAll(new RegExp('\\$\\s*' + NUMBER, 'g'))]
    .find(entry => entry.index !== priceDollarIndex)

  let order: 'SPEND' | 'QUANTITY' = 'SPEND'
  let amount: string | undefined, currency: 'SOL' | 'USDC' = 'USDC'
  let quantity: string | undefined, maxTotalSpend: string | undefined, maxSpendCurrency: 'SOL' | 'USDC' | undefined
  if (quantityMatch) {
    order = 'QUANTITY'
    quantity = quantityMatch[1].replace(',', '.')
    if (decimalsOf(quantity) > 12) throw new InputError('Số lượng RWA có tối đa 12 chữ số thập phân.')
    if (capMatch) {
      maxSpendCurrency = capMatch[2] === 'sol' ? 'SOL' : 'USDC'
      maxTotalSpend = toUnits(capMatch[1], maxSpendCurrency)
      amount = maxTotalSpend; currency = maxSpendCurrency
    }
  } else if (spendMatch) {
    currency = spendMatch[2] === 'sol' ? 'SOL' : 'USDC'
    amount = toUnits(spendMatch[1], currency)
  } else if (dollarSpend) {
    currency = 'USDC'
    amount = toUnits(dollarSpend[1], 'USDC')
  }
  const wantsBuy = /\b(mua|buy|purchase|acquire)\b/.test(value) && !searchOnlyRequest(text) && !!(amount || quantity)
  return rwaIntentSchema.parse({
    category: 'RWA', subtype, symbol, mint: mints[0], amount, currency, order, quantity, maxTotalSpend, maxSpendCurrency,
    condition: targetPrice === undefined ? undefined : { type: 'PRICE_BELOW', targetPrice, priceCurrency: 'USD' },
    requestKind, desiredCategory: hint?.label,
    // A discovery request asks Na to choose, so it carries no spend authority and can never be a BUY.
    // Without an amount, quantity or condition there is nothing to act on either, so report SEARCH.
    action: requestKind === 'SPECIFIC_ASSET' && wantsBuy ? 'BUY' : 'SEARCH',
  })
}
