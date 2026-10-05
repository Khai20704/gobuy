import { InputError } from '../../schemas/search.js'
import { JupiterClient } from './JupiterClient.js'
import { jupiterOrderSchema, SOL_MINT, type JupiterOrder } from './types.js'
export class JupiterQuoteService {
  constructor(readonly client = new JupiterClient(), readonly maxSlippageBps = 100) {}
  async quote(inputMint: string, outputMint: string, amount: string, slippageBps = this.maxSlippageBps, taker?: string): Promise<JupiterOrder> {
    if (!/^[1-9]\d{0,15}$/.test(amount) || slippageBps <= 0 || slippageBps > this.maxSlippageBps) throw new InputError('Số tiền hoặc slippage không hợp lệ.')
    const raw = await this.client.request('order', { inputMint, outputMint, amount, slippageBps: String(slippageBps), ...(taker ? { taker } : {}) })
    const parsed = jupiterOrderSchema.safeParse(raw)
    if (!parsed.success) throw new InputError('Jupiter không có route với đủ dữ liệu kiểm chứng.')
    const quote = parsed.data
    // Jupiter floors the minimum-out, so the exact bound is floor(out * (10000 - bps) / 10000). Requiring
    // `threshold * 10000 >= out * (10000 - bps)` is stricter than that floor and rejects valid quotes whose
    // product is not divisible by 10000 (observed live on SOL -> NVDAx at 100 bps).
    const minimumOut = BigInt(quote.outAmount) * BigInt(10000 - slippageBps) / 10000n
    if (quote.inputMint !== inputMint || quote.outputMint !== outputMint || quote.inAmount !== amount
      || quote.slippageBps > slippageBps || BigInt(quote.otherAmountThreshold) > BigInt(quote.outAmount)
      || BigInt(quote.otherAmountThreshold) < minimumOut
      || quote.expireAt && (!Number.isFinite(Date.parse(quote.expireAt)) || Date.parse(quote.expireAt) <= Date.now())) {
      throw new InputError('Quote Jupiter sai mint, số tiền, slippage hoặc đã hết hạn.')
    }
    return quote
  }
  async policyValue(inputMint: string, amount: string, feeReserveLamports: number) {
    const value = inputMint === SOL_MINT ? BigInt(amount) : (() => undefined)()
    const sol = value ?? BigInt((await this.quote(inputMint, SOL_MINT, amount)).outAmount)
    // Conservative conversion buffer. No LLM conversion or direct USDC-vs-SOL comparison.
    const normalized = (sol * BigInt(10000 + this.maxSlippageBps) + 9999n) / 10000n + BigInt(feeReserveLamports)
    if (normalized > 10000000000000n) throw new InputError('Giá trị quy đổi vượt giới hạn hệ thống.')
    return Number(normalized)
  }
}
