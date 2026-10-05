import { createHash } from 'node:crypto'
import { z } from 'zod'
import { preparedPurchaseSchema, type CandidateItem, type ExchangeRate, type PurchaseAuthorization, type PreparedPurchase,
  type PurchaseState, type RankedCandidate, type SearchIntent } from '@gobuy/shared'
import { verifyCandidate } from '../verification/verifyCandidates.js'
import { convertMoney, decimalFraction, freshRate, sumMoney, type ExchangeRateProvider } from '../currency/SolExchangeRates.js'

const units = z.string().regex(/^(0|[1-9]\d*)$/)
export const checkoutQuoteSchema = z.object({
  orderId: z.string().min(1), productId: z.string(), productUrl: z.string(), merchant: z.string(), recipient: z.string(),
  quantity: z.number().int().positive(), currency: z.literal('SOL'), itemPriceLamports: units, shippingLamports: units, feesLamports: units,
  checkedAt: z.iso.datetime(), expiresAt: z.iso.datetime(), merchantAndDestinationVerified: z.literal(true),
}).strict()
export type CheckoutQuote = z.infer<typeof checkoutQuoteSchema>

// Implemented by a secure wallet/order service, never by an LLM or an arbitrary URL.
// The adapter must authenticate the wallet owner and durably enforce idempotency.
export interface AuthorizedPaymentLayer {
  readonly supportsIdempotency: true
  quote(session: string, item: CandidateItem, quantity: number): Promise<CheckoutQuote>
  authorize(session: string, intent: PreparedPurchase, digest: string): Promise<{ allowed: boolean; digest: string }>
  submit(intent: PreparedPurchase, idempotencyKey: string): Promise<{ transactionReference: string }>
  confirm(transactionReference: string): Promise<{ status: 'CONFIRMED' | 'PENDING' | 'FAILED'; transactionReference: string;
    orderId: string; merchant: string; totalLamports: string }>
}

export function toLamports(value: number, round: 'up' | 'down' = 'up'): bigint {
  if (!Number.isFinite(value) || value < 0) throw new Error('Invalid amount')
  const [coefficient, exponent = '0'] = String(value).toLowerCase().split('e')
  const [whole, fraction = ''] = coefficient.split('.')
  const digits = BigInt(whole + fraction), scale = fraction.length - Number(exponent) - 9
  if (scale <= 0) return digits * 10n ** BigInt(-scale)
  const divisor = 10n ** BigInt(scale)
  return digits / divisor + (round === 'up' && digits % divisor ? 1n : 0n)
}

const blocked = (message: string): PurchaseState => ({ status: 'BLOCKED', message })
export const intentHash = (intent: SearchIntent) => createHash('sha256').update(JSON.stringify(intent)).digest('hex')
export function maximumSolLamports(maximum: number, currency: string, rates: ExchangeRate[]): bigint | undefined {
  if (currency === 'SOL') return toLamports(maximum, 'down')
  const rate = freshRate(rates, currency)
  if (!rate) return undefined
  const [n, d] = decimalFraction(maximum), [rn, rd] = decimalFraction(rate.rate)
  return n * rd * 1000000000n / (d * rn) // exact rational floor: never grants an extra lamport
}
export class PurchaseService {
  private readonly attempts = new Map<string, Promise<PurchaseState>>()
  constructor(private readonly layer?: AuthorizedPaymentLayer) {}
  get available() { return !!this.layer }
  async purchase(session: string, authorization: PurchaseAuthorization, selected: RankedCandidate, intent: SearchIntent,
    refresh: () => Promise<CandidateItem | undefined>, rateProvider?: ExchangeRateProvider): Promise<PurchaseState> {
    if (!this.layer) return blocked('GoBuy payment is not connected. No purchase or SOL transfer was made.')
    const key = `${session}:${authorization.id}`
    const previous = this.attempts.get(key)
    if (previous) return previous
    // Bounded attempts are retained for this process; the payment layer owns durable deduplication.
    if (this.attempts.size >= 1000) return blocked('Payment review capacity reached. No transaction was submitted.')
    const work = this.execute(session, authorization, selected, intent, refresh, rateProvider)
    this.attempts.set(key, work)
    return work
  }
  private async execute(session: string, authorization: PurchaseAuthorization, selected: RankedCandidate, intent: SearchIntent,
    refresh: () => Promise<CandidateItem | undefined>, rateProvider?: ExchangeRateProvider): Promise<PurchaseState> {
    let submitted = false
    const current = selected.item
    try {
      if (!this.layer?.supportsIdempotency || current.mode !== 'real' || intent.action !== 'BUY'
        || authorization.maximum !== intent.maxPrice || authorization.currency !== intent.currency
        || authorization.intentHash !== intentHash(intent)
        || authorization.quantity !== (intent.quantity ?? 1) || Date.parse(authorization.expiresAt) <= Date.now()) {
        return blocked('A current explicit BUY authorization is required. No transaction was submitted.')
      }
      const fresh = await refresh()
      if (!fresh || fresh.mode !== 'real' || !current.seller?.name || fresh.seller?.name !== current.seller.name
        || fresh.id !== current.id || fresh.productUrl !== current.productUrl || fresh.source !== current.source
        || Date.now() - Date.parse(fresh.fetchedAt) > 30000 || Date.parse(fresh.fetchedAt) > Date.now() + 5000
        || ['price', 'currency', 'model', 'size', 'brand', 'condition'].some(field => fresh[field as keyof CandidateItem] !== current[field as keyof CandidateItem])
        || JSON.stringify(fresh.costs) !== JSON.stringify(current.costs)) {
        return blocked('The listing, seller, variant or cost changed, or could not be refreshed. Research again before purchase.')
      }
      const currencies = [...new Set([fresh.currency, authorization.currency].filter((value): value is string => !!value && value !== 'SOL'))]
      const rates: ExchangeRate[] = currencies.length && rateProvider ? await rateProvider.getRates(currencies) : []
      const checked = verifyCandidate(fresh, intent, rates)
      if (checked.hardViolations.length || checked.unmetRequirements.length || checked.effectivePrice === undefined
        || checked.effectivePrice > authorization.maximum) return blocked('The refreshed offer no longer satisfies every purchase requirement or the authorized maximum.')
      if (checked.authenticity !== selected.verification.authenticity || checked.seller.score < selected.verification.seller.score) {
        return blocked('Seller or authenticity evidence changed. Research again before purchase.')
      }
      const quote = checkoutQuoteSchema.parse(await this.layer.quote(session, fresh, authorization.quantity))
      if (quote.productId !== fresh.id || quote.productUrl !== fresh.productUrl || quote.merchant !== fresh.seller?.name
        || quote.quantity !== authorization.quantity || Date.now() - Date.parse(quote.checkedAt) > 30000
        || Date.parse(quote.checkedAt) > Date.now() + 5000 || Date.parse(quote.expiresAt) <= Date.now()) {
        return blocked('The merchant order or payment destination does not match the researched offer.')
      }
      const maximumLamports = maximumSolLamports(authorization.maximum, authorization.currency, rates)
      const expectedItemSol = fresh.price !== undefined && fresh.currency ? convertMoney(sumMoney(Array<number>(authorization.quantity).fill(fresh.price)), fresh.currency, 'SOL', rates) : undefined
      const expectedTotalSol = convertMoney(checked.effectivePrice, authorization.currency, 'SOL', rates)
      if (maximumLamports === undefined || expectedItemSol === undefined || expectedTotalSol === undefined) return blocked('A fresh conversion is required before SOL payment.')
      const total = BigInt(quote.itemPriceLamports) + BigInt(quote.shippingLamports) + BigInt(quote.feesLamports)
      if (BigInt(quote.itemPriceLamports) !== toLamports(expectedItemSol) || total !== toLamports(expectedTotalSol)) return blocked('The final checkout price changed. Research again; no transaction was submitted.')
      const purchaseIntent = preparedPurchaseSchema.parse({ action: 'PURCHASE', authorizationId: authorization.id, productId: fresh.id,
        productUrl: fresh.productUrl, merchant: quote.merchant, orderId: quote.orderId, recipient: quote.recipient,
        quantity: quote.quantity, currency: 'SOL', itemPriceLamports: quote.itemPriceLamports, shippingLamports: quote.shippingLamports,
        feesLamports: quote.feesLamports, totalLamports: total.toString(), authorizedMaximumLamports: maximumLamports.toString(),
        quoteExpiresAt: quote.expiresAt, exchangeRate: freshRate(rates, fresh.currency === 'SOL' ? authorization.currency : fresh.currency ?? ''),
      })
      const digest = createHash('sha256').update(JSON.stringify(purchaseIntent)).digest('hex')
      const permission = await this.layer.authorize(session, purchaseIntent, digest)
      if (!permission.allowed || permission.digest !== digest || Date.parse(quote.expiresAt) <= Date.now()
        || Date.parse(authorization.expiresAt) <= Date.now()
        || rates.some(rate => !freshRate([rate], rate.quoteCurrency))) return blocked('The secure payment layer did not authorize this exact, current purchase.')
      submitted = true
      const transaction = await this.layer.submit(purchaseIntent, authorization.id)
      const receipt = await this.layer.confirm(transaction.transactionReference)
      if (receipt.transactionReference !== transaction.transactionReference || receipt.orderId !== quote.orderId
        || receipt.merchant !== quote.merchant || receipt.totalLamports !== purchaseIntent.totalLamports) {
        return { status: 'PENDING', message: 'Payment confirmation does not match this order. No automatic retry will occur.', purchaseIntent }
      }
      return { status: receipt.status, purchaseIntent, transactionReference: receipt.transactionReference,
        message: receipt.status === 'CONFIRMED' ? 'PURCHASED — payment and merchant order confirmed.'
          : receipt.status === 'FAILED' ? 'Payment failed. The item was not reported as purchased; no automatic retry will occur.'
            : 'Payment is pending confirmation. The item is not yet reported as purchased.' }
    } catch {
      return submitted ? { status: 'PENDING', message: 'Submission or confirmation is uncertain. Check the payment layer; no automatic retry will occur.' }
        : blocked('Purchase checks failed. No payment was submitted.')
    }
  }
}
