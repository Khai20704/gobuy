import { z } from 'zod'

// Request-scoped search constraints. These are never written to a Mandate.
export const purchaseIntentSchema = z.object({
  requestId: z.uuid(), assetType: z.enum(['NFT', 'RWA', 'PHYSICAL']),
  query: z.string().trim().min(1).max(2000),
  budget: z.object({ amount: z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER),
    currency: z.string().regex(/^[A-Z]{3,4}$/) }).strict().optional(),
  preferences: z.object({ collectionSymbol: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/).optional(),
    authentic: z.boolean().optional(), reputableSeller: z.boolean().optional(), riskLevel: z.number().int().min(0).max(3).optional() }).strict().optional(),
}).strict()
export type PurchaseIntent = z.infer<typeof purchaseIntentSchema>

export const pageContextSchema = z.object({
  classification: z.literal('UNTRUSTED_EXTERNAL_CONTENT'),
  url: z.url().max(2048).refine(value => {
    const u = new URL(value)
    return u.protocol === 'https:' && !u.username && !u.password && !u.port
      && ['magiceden.io', 'www.magiceden.io', 'ondo.finance', 'www.ondo.finance', 'app.ondo.finance', 'www.ebay.com', 'www.nike.com'].includes(u.hostname)
  }),
  title: z.string().max(300), priceText: z.string().max(80).optional(),
  collectionSymbol: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/).optional(),
}).strict()
export type PageContext = z.infer<typeof pageContextSchema>

export const actionLogSchema = z.object({
  id: z.uuid(), requestId: z.uuid(), timestamp: z.iso.datetime(), request: z.string().max(2000),
  asset: z.string().max(300).optional(), price: z.number().nonnegative().optional(), currency: z.string().optional(),
  provider: z.string().max(200), status: z.enum(['SEARCHED', 'NO_MATCH', 'PROPOSED', 'APPROVED', 'REJECTED', 'EXECUTED', 'FAILED']),
  reason: z.string().max(2000), signature: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{64,88}$/).optional(),
}).strict()
export type ActionLog = z.infer<typeof actionLogSchema>
