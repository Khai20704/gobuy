import { z } from 'zod'
import { purchaseIntentSchema, pageContextSchema } from './intent.js'
import { investmentPreferencesSchema } from './intelligence.js'

// API endpoints are fixed. The bounded page reader separately validates and pins DNS.
export function isPublicHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value)
    const host = url.hostname.toLowerCase().replace(/\.$/, '')
    return url.protocol === 'https:' && !url.username && !url.password && (!url.port || url.port === '443')
      && host.includes('.') && !host.includes(':') && !/^[\d.]+$/.test(host)
      && !/(^|\.)(localhost|local|internal|test|invalid)$/.test(host)
  } catch { return false }
}
export const publicUrlSchema = z.string().max(2048).refine(isPublicHttpsUrl, 'Expected a public HTTPS URL')
const text = z.string().trim().min(1).max(300)
const money = z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER)
const score = z.number().finite().min(0).max(100)
export const confidenceSchema = z.enum(['VERIFIED', 'HIGH CONFIDENCE', 'MEDIUM CONFIDENCE', 'LOW CONFIDENCE', 'UNKNOWN'])
const importance = z.enum(['low', 'medium', 'high'])
export const evidenceSchema = z.object({
  field: text, statement: z.string().min(1).max(1200), reference: publicUrlSchema, retrievedAt: z.iso.datetime(),
  kind: z.enum(['SOURCE_CLAIM', 'VERIFIED_FACT']),
}).strict()
export const searchIntentSchema = z.object({
  sourceClassification: z.literal('UNTRUSTED_EXTERNAL_CONTENT').optional(),
  action: z.enum(['FIND', 'BUY']).optional(), quantity: z.number().int().min(1).max(100).optional(),
  category: text.optional(), product: text.optional(), brand: text.optional(), model: text.optional(),
  size: text.optional(), compatibleWith: text.optional(),
  keywords: z.array(z.string().trim().min(1).max(80)).min(1).max(12),
  maxPrice: money.optional(), minPrice: money.optional(), currency: z.string().regex(/^[A-Z]{3,4}$/).optional(),
  collectionSymbol: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/).optional(),
  preferences: z.object({
    authentic: z.boolean().optional(), reputableSeller: z.boolean().optional(),
    condition: text.optional(), shippingCountry: z.string().regex(/^[A-Z]{2}$/).optional(),
    priceSensitivity: importance.optional(), minSellerTrust: score.optional(), riskLevel: z.number().int().min(0).max(3).optional(),
  }).strict(),
}).strict().refine(v => v.minPrice === undefined || v.maxPrice === undefined || v.minPrice <= v.maxPrice, 'Invalid price range')
export type SearchIntent = z.infer<typeof searchIntentSchema>
export const researchRequestSchema = z.object({ text: z.string().trim().min(1).max(2000), previousSearchId: z.uuid().optional(), structuredIntent: purchaseIntentSchema.optional(), pageContext: pageContextSchema.optional() }).strict()

export const exchangeRateSchema = z.object({ base: z.literal('SOL'), quoteCurrency: z.string().regex(/^[A-Z]{3,4}$/),
  rate: z.number().finite().positive(), observedAt: z.iso.datetime(), fetchedAt: z.iso.datetime(), sourceUrl: publicUrlSchema }).strict()
export type ExchangeRate = z.infer<typeof exchangeRateSchema>
export const purchaseAuthorizationSchema = z.object({ id: z.uuid(), action: z.literal('BUY'), maximum: money,
  currency: z.string().regex(/^[A-Z]{3,4}$/), quantity: z.number().int().min(1).max(100), intentHash: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: z.iso.datetime(), expiresAt: z.iso.datetime() }).strict()
export type PurchaseAuthorization = z.infer<typeof purchaseAuthorizationSchema>
const lamports = z.string().regex(/^(0|[1-9]\d*)$/).refine(v => BigInt(v) <= 18446744073709551615n)
export const preparedPurchaseSchema = z.object({ action: z.literal('PURCHASE'), authorizationId: z.uuid(), productId: text,
  productUrl: publicUrlSchema, merchant: text, orderId: text, recipient: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/),
  quantity: z.number().int().positive(), currency: z.literal('SOL'), itemPriceLamports: lamports, shippingLamports: lamports,
  feesLamports: lamports, totalLamports: lamports, authorizedMaximumLamports: lamports,
  quoteExpiresAt: z.iso.datetime(), exchangeRate: exchangeRateSchema.optional(),
}).strict().refine(v => BigInt(v.totalLamports) === BigInt(v.itemPriceLamports) + BigInt(v.shippingLamports) + BigInt(v.feesLamports)
  && BigInt(v.totalLamports) <= BigInt(v.authorizedMaximumLamports), 'Purchase exceeds authorization or costs do not add up')
export type PreparedPurchase = z.infer<typeof preparedPurchaseSchema>
export const purchaseStateSchema = z.object({ status: z.enum(['NOT_REQUESTED', 'BLOCKED', 'PENDING', 'CONFIRMED', 'FAILED']),
  message: z.string(), transactionReference: text.optional(), purchaseIntent: preparedPurchaseSchema.optional() }).strict()
export type PurchaseState = z.infer<typeof purchaseStateSchema>

export const candidateItemSchema = z.object({
  id: z.string().min(1).max(200), title: text, description: z.string().max(1200).optional(),
  price: money.optional(), currency: z.string().regex(/^[A-Z]{3,4}$/).optional(),
  imageUrl: publicUrlSchema.optional(), productUrl: publicUrlSchema,
  source: z.string().min(1).max(80), domain: z.string().min(1).max(253),
  mode: z.enum(['real', 'mock']), kind: z.enum(['product', 'nft', 'rwa', 'web-page']),
  fetchedAt: z.iso.datetime(), condition: text.optional(), brand: text.optional(), model: text.optional(),
  size: text.optional(), compatibleWith: z.array(text).max(50).optional(),
  evidence: z.array(evidenceSchema).max(100).optional(),
  purchaseCount: z.number().int().nonnegative().optional(),
  productRating: z.number().min(0).max(5).optional(), productReviewCount: z.number().int().nonnegative().optional(),
  stockStatus: z.enum(['IN_STOCK', 'LIMITED_STOCK', 'OUT_OF_STOCK']).optional(),
  costs: z.object({ shipping: money.optional(), requiredFees: money.optional(), currency: z.string().regex(/^[A-Z]{3,4}$/),
    shippingCountry: z.string().regex(/^[A-Z]{2}$/).optional(), quantity: z.number().int().positive().optional() }).strict().optional(),
  collectionSymbol: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/).optional(),
  nft: z.object({ mint: text, collectionAddress: text.optional(), seller: text, listingStatus: z.literal('LISTED'), marketplace: z.literal('Magic Eden') }).strict().optional(),
  rwa: z.object({ protocol: z.literal('Ondo'), token: text, network: text, apy: money.optional(), apySource: publicUrlSchema.optional(), riskLevel: z.number().int().min(0).max(3), risks: z.array(text).min(1), observedAt: z.iso.datetime() }).strict().optional(),
  seller: z.object({
    name: text.optional(), rating: score.optional(), ratingScale: z.enum(['percent', 'five-star']).optional(),
    reviewCount: z.number().int().nonnegative().optional(),
    feedbackScore: z.number().int().optional(), verified: z.boolean().optional(),
    historyYears: z.number().finite().nonnegative().max(200).optional(),
    officialStore: z.boolean().optional(),
  }).strict().optional(),
  signals: z.object({
    returnsAccepted: z.boolean().optional(), returnPolicy: z.string().max(500).optional(),
    shippingCountries: z.array(z.string().regex(/^[A-Z]{2}$/)).max(250).optional(),
    excludedShippingCountries: z.array(z.string().regex(/^[A-Z]{2}$/)).max(250).optional(),
    warranty: z.string().max(500).optional(),
    website: z.object({ businessIdentity: text.optional(), contact: text.optional(),
      returnPolicy: z.boolean().optional(), paymentMethods: z.array(text).max(20).optional(),
      independentReputation: z.enum(['positive', 'negative']).optional(), authorizedRetailer: z.boolean().optional(),
      buyerProtection: z.boolean().optional(), suspiciousClaims: z.boolean().optional(),
    }).strict().optional(),
    authenticity: z.object({
      status: z.union([confidenceSchema, z.literal('CONFLICTING')]), basis: z.enum(['platform-attestation', 'manufacturer', 'listing-claim']),
      reference: publicUrlSchema, note: z.string().max(500),
    }).strict().optional(),
  }).strict(),
}).strict().refine(v => v.seller?.rating === undefined || (v.seller.ratingScale !== undefined
  && (v.seller.ratingScale !== 'five-star' || v.seller.rating <= 5)), 'Rating requires its scale')
export type CandidateItem = z.infer<typeof candidateItemSchema>
export const sellerEvaluationSchema = z.object({ score, reasons: z.array(z.string()), missingSignals: z.array(z.string()) }).strict()
export type SellerEvaluation = z.infer<typeof sellerEvaluationSchema>
export const verificationSchema = z.object({
  budget: z.enum(['WITHIN', 'OUTSIDE', 'UNKNOWN', 'NOT_SET']),
  productMatch: score, authenticity: confidenceSchema, confidence: confidenceSchema,
  seller: sellerEvaluationSchema, signals: z.array(z.string()), warnings: z.array(z.string()),
  hardViolations: z.array(z.string()), unmetRequirements: z.array(z.string()),
  effectivePrice: money.optional(), knownPayablePrice: money.optional(),
  assessmentCurrency: z.string().regex(/^[A-Z]{3,4}$/).optional(), exchangeRate: exchangeRateSchema.optional(),
  priceAssessment: z.enum(['VERY LOW', 'COMPETITIVE', 'NORMAL', 'EXPENSIVE', 'UNKNOWN']),
  priceBasis: z.enum(['EFFECTIVE', 'LISTED', 'UNKNOWN']), comparedOffers: z.number().int().nonnegative(),
  productEvidenceScore: score,
  website: z.object({ status: z.enum(['HIGH CONFIDENCE', 'MEDIUM CONFIDENCE', 'LOW CONFIDENCE', 'UNKNOWN']),
    score, reasons: z.array(z.string()), missingSignals: z.array(z.string()) }).strict(),
}).strict()
export type Verification = z.infer<typeof verificationSchema>
export const rankingWeightsSchema = z.object({ productMatch: money, budgetMatch: money, sellerTrust: money,
  productEvidence: money, websiteTrust: money, preferenceMatch: money }).strict()
export const DEFAULT_RANKING_WEIGHTS = { productMatch: 25, budgetMatch: 20, sellerTrust: 20, productEvidence: 15, websiteTrust: 10, preferenceMatch: 10 }
export type RankingWeights = z.infer<typeof rankingWeightsSchema>
export const rankedCandidateSchema = z.object({
  item: candidateItemSchema, verification: verificationSchema, totalScore: score,
  scoreBreakdown: rankingWeightsSchema, reasons: z.array(z.string()), preferenceReasons: z.array(z.string()),
  explanation: z.string().max(2000),
}).strict()
export type RankedCandidate = z.infer<typeof rankedCandidateSchema>
export const twinPreferencesSchema = z.object({
  investment: investmentPreferencesSchema.optional(),
  sellerReputationImportance: importance.optional(), priceSensitivity: importance.optional(),
  acceptHigherPriceForTrustedSeller: z.number().min(0).max(0.2).optional(),
  authentic: z.boolean().optional(),
  maxPrice: money.optional(), currency: z.string().regex(/^[A-Z]{3,4}$/).optional(),
  condition: text.optional(), shippingCountry: z.string().regex(/^[A-Z]{2}$/).optional(), minSellerTrust: score.optional(),
  preferredBrands: z.array(text).max(20).optional(), preferredStores: z.array(text).max(20).optional(),
}).strict()
export type TwinPreferences = z.infer<typeof twinPreferencesSchema>
export const rejectionReasonSchema = z.enum(['Too expensive', 'Seller not trusted', 'Wrong style', 'Wrong brand', 'Not interested'])
export const decisionInputSchema = z.object({
  searchId: z.uuid(), candidateId: z.string().min(1).max(200), outcome: z.enum(['approve', 'reject']),
  reason: rejectionReasonSchema.optional(),
}).strict().refine(v => v.outcome === 'reject' || v.reason === undefined, 'Approval cannot contain a rejection reason')
export type DecisionInput = z.infer<typeof decisionInputSchema>
export const decisionSchema = z.object({
  id: z.uuid(), searchId: z.uuid(), outcome: z.enum(['approve', 'reject']), reason: rejectionReasonSchema.optional(),
  item: candidateItemSchema, trustScore: score, at: z.iso.datetime(),
  trustedPricePremium: z.number().min(0).max(0.2).optional(),
}).strict()
export type CommerceDecision = z.infer<typeof decisionSchema>
export const commerceTwinSchema = z.object({
  explicit: twinPreferencesSchema, learned: twinPreferencesSchema, effective: twinPreferencesSchema,
  learningReasons: z.array(z.string()), history: z.array(decisionSchema).max(200),
  autonomyBoundaries: z.object({ requiresUserApproval: z.literal(true), purchasesEnabled: z.literal(false), authority: z.literal('existing-signed-mandate') }).strict(),
}).strict()
export type CommerceTwin = z.infer<typeof commerceTwinSchema>
export const providerReportSchema = z.object({
  provider: z.string(), mode: z.enum(['real', 'mock']), status: z.enum(['ok', 'failed', 'skipped']),
  count: z.number().int().nonnegative(), message: z.string().optional(),
}).strict()
export type ProviderReport = z.infer<typeof providerReportSchema>
export const researchResponseSchema = z.object({
  searchId: z.uuid(), expiresAt: z.iso.datetime(), mode: z.enum(['real', 'mock', 'mixed']),
  intent: searchIntentSchema, intentMode: z.enum(['llm', 'dev-parser', 'budget-update', 'deterministic', 'structured']),
  purchaseIntent: purchaseIntentSchema.optional(), ai: z.object({ provider: z.string(), fallback: z.boolean() }).strict().optional(),
  explanationMode: z.enum(['llm-grounded', 'deterministic']),
  recommendations: z.array(rankedCandidateSchema).max(1), providers: z.array(providerReportSchema),
  discoveries: z.array(z.object({ item: candidateItemSchema, reasons: z.array(z.string()) }).strict()).max(10).optional(),
  researchedCount: z.number().int().nonnegative(), eligibleCount: z.number().int().nonnegative(),
  status: z.enum(['SELECTED', 'SETUP_REQUIRED', 'SEARCH_UNAVAILABLE', 'NO_MATCH', 'BUDGET_TOO_LOW', 'NEEDS_INFORMATION']),
  nextStep: z.string(), exchangeRates: z.array(exchangeRateSchema),
  authorization: purchaseAuthorizationSchema.optional(), purchase: purchaseStateSchema,
  budgetSuggestion: z.object({ item: candidateItemSchema, minimum: money, currency: z.string().regex(/^[A-Z]{3,4}$/),
    explanation: z.string() }).strict().optional(),
  warnings: z.array(z.string()), summary: z.string(), twin: commerceTwinSchema,
}).strict()
export type ResearchResponse = z.infer<typeof researchResponseSchema>
export const researchHandoffSchema = z.object({
  decisionId: z.uuid(), item: candidateItemSchema, status: z.literal('REVIEW_REQUIRED'),
  blockers: z.array(z.string()).min(1),
}).strict()
export type ResearchHandoff = z.infer<typeof researchHandoffSchema>
export const decisionResponseSchema = z.object({
  decision: decisionSchema, twin: commerceTwinSchema, handoff: researchHandoffSchema.optional(),
}).strict()
export type DecisionResponse = z.infer<typeof decisionResponseSchema>
