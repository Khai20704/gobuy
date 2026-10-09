import { z } from 'zod'
export const SOL_MINT = 'So11111111111111111111111111111111111111112'
export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const units = z.string().regex(/^[1-9]\d{0,19}$/)
export const jupiterOrderSchema = z.object({
  inputMint: z.string(), outputMint: z.string(), inAmount: units, outAmount: units,
  otherAmountThreshold: units, slippageBps: z.number().int().nonnegative(),
  priceImpactPct: z.union([z.number(), z.string().regex(/^-?\d+(?:\.\d+)?$/)]).transform(Number).pipe(z.number().finite()).optional(),
  swapMode: z.literal('ExactIn'), requestId: z.string().min(1).optional(),
  transaction: z.string().nullable().optional(), expireAt: z.string().optional(),
  routePlan: z.array(z.object({ swapInfo: z.object({ label: z.string().optional() }).passthrough() }).passthrough()).min(1),
  signatureFeeLamports: z.number().int().nonnegative().optional(),
  prioritizationFeeLamports: z.number().int().nonnegative().optional(), rentFeeLamports: z.number().int().nonnegative().optional(),
  lastValidBlockHeight: z.union([z.number().int().positive(), z.string().regex(/^[1-9]\d*$/)]).optional(),
})
export type JupiterOrder = z.infer<typeof jupiterOrderSchema>
