import { decimalFraction, freshRate, type ExchangeRateProvider } from '../currency/SolExchangeRates.js'
import { normalizeText, parseDemoBuy } from './catalog.js'

// USD is a reference budget only. Devnet SOL has no redeemable USD value.
export async function resolveDemoBuy(text: string, rates: ExchangeRateProvider) {
  const value = normalizeText(text)
  if (!/\$|\b(?:usd|do|dollar|dollars)\b/.test(value)) return parseDemoBuy(text)
  const amounts = [...value.matchAll(/(duoi|under|below|toi da|maximum|max|budget|up to)\s*(?:\$\s*(\d+(?:[.,]\d{1,2})?)|(\d+(?:[.,]\d{1,2})?)\s*(?:usd|do(?: la)?|dollars?)\b)/g)]
  if (amounts.length !== 1 || /\b(?:sol|usdc|vnd|eur)\b/.test(value)) return { message: 'Hãy nêu một ngân sách duy nhất: dưới 5 đô, dưới $5 hoặc dưới 0.5 SOL.' }
  const match = amounts[0]
  const amount = Number((match[2] || match[3]).replace(',', '.'))
  if (!Number.isFinite(amount) || amount <= 0 || amount > 10000) return { message: 'Ngân sách USD phải lớn hơn 0 và không quá 10.000 USD.' }
  // Validate purchase intent and subject before calling a rate provider.
  const intent = parseDemoBuy(value.replace(match[0], 'under 1 sol'))
  if ('message' in intent) return intent
  try {
    const rate = freshRate(await rates.getRates(['USD']), 'USD')
    if (!rate) throw new Error('No fresh USD rate')
    const [n, d] = decimalFraction(amount), [rn, rd] = decimalFraction(rate.rate)
    const numerator = n * rd * 1000000000n, denominator = d * rn
    const strict = /^(duoi|under|below)$/.test(match[1])
    const maximum = strict ? (numerator - 1n) / denominator : numerator / denominator
    if (maximum <= 0) return { message: 'Ngân sách quá nhỏ để thực hiện giao dịch.' }
    return { maximumLamports: Number(maximum > 10000000000n ? 10000000000n : maximum), topic: intent.topic,
      conversion: { maximumUsd: amount, usdPerSol: rate.rate, observedAt: rate.observedAt, sourceUrl: rate.sourceUrl },
      note: `Ngân sách ${amount} USD quy đổi tham khảo theo 1 SOL = ${rate.rate} USD. Chỉ thanh toán Devnet SOL, không trừ USD thật.` }
  } catch { return { message: 'Chưa lấy được tỷ giá SOL/USD mới. Chưa tạo giao dịch; thử lại hoặc nhập ngân sách bằng SOL.' } }
}
