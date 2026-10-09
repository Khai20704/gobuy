import { z } from 'zod'

export const purchasePhaseSchema = z.enum(['PAYMENT_PENDING', 'PAYMENT_CONFIRMED', 'DELIVERY_PENDING',
  'DELIVERY_CONFIRMED', 'COMPLETED', 'DELIVERY_FAILED'])
export type PurchasePhase = z.infer<typeof purchasePhaseSchema>
export const deliveryRecoverySchema = z.object({
  status: z.enum(['pending', 'preparing', 'submitted', 'confirming', 'retrying', 'completed', 'requires_attention']),
  retryCount: z.number().int().nonnegative(), nextRetryAt: z.string().nullable(),
  lastError: z.string().nullable(), updatedAt: z.string(),
})
export const deliveryPricingSchema = z.object({
  amount: z.string(), currency: z.enum(['SOL', 'USDC']), paymentLamports: z.string(),
  referencePrice: z.string(), referenceCurrency: z.enum(['SOL', 'USDC']),
  source: z.string(), observedAt: z.string(),
  referenceAmount: z.string(),
})
export const devnetDeliverySchema = z.object({
  replacementAcceptedAt: z.string().optional(),
  deliveryState: z.enum(['DELIVERY_PENDING', 'MINTING', 'DELIVERY_CONFIRMING', 'DELIVERED', 'REQUIRES_ATTENTION']).optional(),
  deliveryMode: z.enum(['TRANSFER_NFT', 'DEMO_NFT', 'RWA_TOKEN', 'DEVNET_DEMO_MINT', 'ORIGINAL_NFT_TRANSFER']).optional(),
  recipientWallet: z.string().optional(), demoName: z.string().optional(), paymentLamports: z.string().nullable().transform(value => value ?? undefined).optional(),
  id: z.string(), owner: z.string(), kind: z.enum(['NFT', 'RWA']), name: z.string(), sourceMint: z.string(),
  mint: z.string().nullable().transform(value => value ?? undefined).optional(), quantity: z.string(), rawQuantity: z.string(), decimals: z.number().int(),
  network: z.literal('devnet'), simulated: z.boolean(), phase: purchasePhaseSchema,
  paymentSignature: z.string(), signature: z.string().nullable().transform(value => value ?? undefined).optional(), pricing: deliveryPricingSchema.nullable().transform(value => value ?? undefined).optional(),
  ownership: z.enum(['verified', 'not_owned', 'unknown']), balance: z.string().nullable().transform(value => value ?? undefined).optional(), message: z.string(),
  payment: z.object({ status: z.literal('confirmed'), signature: z.string() }).optional(),
  recovery: deliveryRecoverySchema.optional(),
})
export type DevnetDelivery = z.infer<typeof devnetDeliverySchema>
export const walletHoldingSchema = z.object({
  owner: z.string(), mint: z.string(), rawQuantity: z.string(), quantity: z.string(), decimals: z.number(),
  tokenAccount: z.string(), network: z.literal('devnet'),
})
export type WalletHolding = z.infer<typeof walletHoldingSchema>
export const undeliveredPaymentSchema = z.object({
  id: z.string(), kind: z.enum(['NFT', 'RWA']), owner: z.string(), name: z.string(),
  paymentSignature: z.string(), amountLamports: z.string(), reason: z.string(),
})
export type UndeliveredPayment = z.infer<typeof undeliveredPaymentSchema>
