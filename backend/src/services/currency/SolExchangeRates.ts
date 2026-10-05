import { z } from 'zod'
import { exchangeRateSchema, type ExchangeRate } from '@gobuy/shared'
import { fetchJson, type Fetcher } from '../search/http.js'

export interface ExchangeRateProvider { getRates(currencies: string[]): Promise<ExchangeRate[]> }
export function decimalFraction(value: number): [bigint, bigint] {
  if (!Number.isFinite(value) || value < 0) throw new Error('Invalid monetary value')
  const [coefficient, exponent = '0'] = String(value).toLowerCase().split('e')
  const [whole, decimal = ''] = coefficient.split('.')
  const scale = decimal.length - Number(exponent), digits = BigInt(whole + decimal)
  return scale >= 0 ? [digits, 10n ** BigInt(scale)] : [digits * 10n ** BigInt(-scale), 1n]
}
export function sumMoney(values: number[]): number {
  const fractions = values.map(decimalFraction)
  const denominator = fractions.reduce((largest, [, d]) => d > largest ? d : largest, 1n)
  return Number(fractions.reduce((sum, [n, d]) => sum + n * (denominator / d), 0n)) / Number(denominator)
}
export function freshRate(rates: ExchangeRate[], currency: string): ExchangeRate | undefined {
  return rates.find(rate => rate.quoteCurrency === currency && rate.rate > 0
    && Date.now() - Date.parse(rate.observedAt) <= 120000 && Date.parse(rate.observedAt) <= Date.now() + 5000)
}
export function convertMoney(value: number, from: string, to: string, rates: ExchangeRate[]): number | undefined {
  if (from === to) return value
  if (to === 'SOL') {
    const rate = freshRate(rates, from)
    if (!rate) return undefined
    const [n, d] = decimalFraction(value), [rn, rd] = decimalFraction(rate.rate)
    const numerator = n * rd * 1000000000n, denominator = d * rn
    return Number((numerator + denominator - 1n) / denominator) / 1e9
  }
  if (from === 'SOL') { const rate = freshRate(rates, to); return rate ? value * rate.rate : undefined }
  return undefined
}

export class SolExchangeRates implements ExchangeRateProvider {
  constructor(private readonly key?: string, private readonly fetcher: Fetcher = fetch) {}
  async getRates(currencies: string[]): Promise<ExchangeRate[]> {
    const requested = [...new Set(currencies.filter(currency => /^[A-Z]{3}$/.test(currency) && currency !== 'SOL'))]
    if (!requested.length) return []
    const url = new URL('https://api.coingecko.com/api/v3/simple/price')
    url.searchParams.set('ids', 'solana'); url.searchParams.set('vs_currencies', requested.map(value => value.toLowerCase()).join(','))
    url.searchParams.set('include_last_updated_at', 'true')
    const body = z.object({ solana: z.record(z.string(), z.number().finite()) }).parse(await fetchJson(url, {
      signal: AbortSignal.timeout(5000), headers: this.key ? { 'x-cg-demo-api-key': this.key } : {},
    }, this.fetcher))
    const observed = body.solana.last_updated_at
    if (!observed || Date.now() - observed * 1000 > 120000 || observed * 1000 > Date.now() + 5000) throw new Error('Exchange rate unavailable or stale')
    return requested.flatMap(currency => {
      const rate = body.solana[currency.toLowerCase()]
      return rate > 0 ? [exchangeRateSchema.parse({ base: 'SOL', quoteCurrency: currency, rate,
        observedAt: new Date(observed * 1000).toISOString(), fetchedAt: new Date().toISOString(), sourceUrl: url.toString() })] : []
    })
  }
}
