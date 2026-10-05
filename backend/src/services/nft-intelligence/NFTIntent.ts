import type { NFTInvestmentIntent } from '@gobuy/shared'
import { normalizeIntentText, investmentRequest } from '../acquisition/intentLanguage.js'

export function investmentIntent(text: string): NFTInvestmentIntent | undefined {
  const value = normalizeIntentText(text)
  const mostBought = /\b(most bought|bought the most|being bought most|duoc mua nhieu nhat|mua nhieu nhat|mua nhieu hon)\b/.test(value)
  if (!investmentRequest(text) && !mostBought
    && !/\b(momentum|trending|xu huong|tang manh|liquid|liquidity|thanh khoan|value|dinh gia|gia tri|uy tin|reputable|strongest)\b/.test(value)) return undefined
  return { category: 'NFT', chain: 'solana',
    objective: mostBought ? 'most_bought'
      : /\b(liquid|liquidity|thanh khoan)\b/.test(value) ? 'best_liquidity'
      : /\b(value|dinh gia|gia tri)\b/.test(value) ? 'value'
        : /\b(trending|xu huong)\b/.test(value) ? 'trending' : 'strongest_momentum',
    horizon: /\b(1h|1 gio|hour)\b/.test(value) ? '1h' : /\b(7d|7 ngay|week|tuan)\b/.test(value) ? '7d' : '24h',
    riskTolerance: /\b(low risk|rui ro thap|an toan|uy tin|reputable)\b/.test(value) ? 'low'
      : /\b(high risk|rui ro cao)\b/.test(value) ? 'high' : 'medium',
    futurePredictionRequested: /\b(tuong lai|du doan|xac suat|ti le|future|predict|probability|will|likely|x2|x10)\b/.test(value),
  }
}
