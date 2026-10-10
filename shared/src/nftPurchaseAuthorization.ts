import { z } from 'zod'
import { walletAddressSchema } from './acquisition.js'

/**
 * Contract for a genuine original-NFT purchase through the Na Vault.
 *
 * Nothing here can authorize a spend: the Anchor program is the final authority. These helpers
 * mirror `anchor/programs/gobuy_na/src/nft_purchase_rules.rs` so the UI can show the same
 * arithmetic and name the exact on-chain refusal, and so the backend can refuse to even build a
 * transaction the vault would reject.
 *
 * A settlement mandate is NOT permission to buy NFTs from arbitrary sellers. Genuine purchases
 * need a separate, owner-signed, versioned authorization account.
 */

/** Account layout version stored on chain. A different version is refused by the program. */
export const NFT_PURCHASE_AUTH_VERSION = 1

/** Seed for the versioned purchase authorization PDA: `["nft-auth", mandate]`. */
export const NFT_AUTH_SEED = 'nft-auth'
/** Seed for one immutable purchase receipt PDA: `["purchase", mandate, orderId]`. */
export const PURCHASE_SEED = 'purchase'

/** Fixed Devnet Tensor Marketplace program id (mirrors `TENSOR_MARKETPLACE_PROGRAM` in Rust). */
export const TENSOR_MARKETPLACE_PROGRAM_ID = 'TCMPhJdwDryooaGtiocG1u3xcYbRpiJzb283XfCZsDp'
/** `sha256("global:buy_legacy")[..8]`, checked against the installed official SDK. */
export const TENSOR_BUY_LEGACY_DISCRIMINATOR = '447f2b08d41ff972'
/** ListState PDA seed: `["list_state", mint]` under the marketplace program. */
export const TENSOR_LIST_STATE_SEED = 'list_state'
/** BuyLegacy carries exactly these accounts; absent optionals use the marketplace program id. */
export const TENSOR_BUY_LEGACY_ACCOUNTS = 24
/** Byte length of the BuyLegacy data for a public SOL listing: discriminator + u64 + None + None. */
export const TENSOR_BUY_LEGACY_DATA_LENGTH = 18

/** Overhead allowance on top of the listing price: 5% plus a small lamport floor for ATA rent. */
export const PURCHASE_OVERHEAD_BPS = 500n
export const PURCHASE_OVERHEAD_LAMPORTS = 5_000_000n
const BPS_DENOMINATOR = 10_000n

/** Every way a genuine purchase can be refused, in the program's own vocabulary. */
export const NFT_PURCHASE_REJECTIONS = ['PurchaseAuthorizationNotActive', 'PurchaseAuthorizationExpired',
  'PurchaseAuthorizationMismatch', 'PurchaseAuthorizationBudgetExceeded', 'InvalidPurchaseOrder',
  'InvalidListing', 'InvalidMarketplaceProgram', 'InvalidBuyer', 'InvalidBuyerTokenAccount',
  'InvalidTensorAccounts', 'InvalidPrice', 'PurchaseNotDelivered', 'VaultDebitExceeded',
  'UnsupportedTokenStandard'] as const
export type NftPurchaseRejection = typeof NFT_PURCHASE_REJECTIONS[number]

/**
 * Mandate-level refusals the genuine purchase path can surface too. Listed literally rather than
 * imported from `mandate.ts`, which already imports this module: a cycle there would make the
 * schema's evaluation order fragile.
 */
export const PURCHASE_MANDATE_REJECTIONS = ['MandateNotActive', 'MandateExpired', 'BudgetExceeded',
  'InsufficientVaultBalance', 'InvalidCategory'] as const

/** Every rejection a genuine purchase result may carry, purchase-specific and mandate-level. */
export const NFT_PURCHASE_RESULT_REJECTIONS = ['PurchaseAuthorizationNotActive', 'PurchaseAuthorizationExpired',
  'PurchaseAuthorizationMismatch', 'PurchaseAuthorizationBudgetExceeded', 'InvalidPurchaseOrder',
  'InvalidListing', 'InvalidMarketplaceProgram', 'InvalidBuyer', 'InvalidBuyerTokenAccount',
  'InvalidTensorAccounts', 'InvalidPrice', 'PurchaseNotDelivered', 'VaultDebitExceeded',
  'UnsupportedTokenStandard', 'MandateNotActive', 'MandateExpired', 'BudgetExceeded',
  'InsufficientVaultBalance', 'InvalidCategory'] as const
export type NftPurchaseResultRejection = typeof NFT_PURCHASE_RESULT_REJECTIONS[number]

/** Failure codes the purchase path can surface without a transaction ever being built. */
export const NFT_PURCHASE_OUTCOMES = ['NO_EXECUTABLE_LISTING', 'AUTHORIZATION_REQUIRED',
  'PURCHASE_DISABLED', 'LISTING_UNAVAILABLE', 'LISTING_CHANGED', 'PRICE_CHANGED'] as const
export type NftPurchaseOutcome = typeof NFT_PURCHASE_OUTCOMES[number]

/** Upper bound the vault may be debited for a listing of `priceLamports`. */
export function maxAllowedDebit(priceLamports: bigint): bigint {
  if (priceLamports <= 0n) throw new Error('Purchase price must be greater than 0 lamports.')
  return priceLamports + (priceLamports * PURCHASE_OVERHEAD_BPS) / BPS_DENOMINATOR + PURCHASE_OVERHEAD_LAMPORTS
}

export type NftPurchaseAuthorizationState = {
  version: number
  active: boolean
  mandate: string
  owner: string
  executor: string
  marketplace: string
  recipient: string
  maxTotalDebitLamports: bigint
  spentLamports: bigint
  expiresAt: number
}

export function authorizationRemaining(state: Pick<NftPurchaseAuthorizationState, 'maxTotalDebitLamports' | 'spentLamports'>): bigint {
  return state.maxTotalDebitLamports > state.spentLamports ? state.maxTotalDebitLamports - state.spentLamports : 0n
}

export type NftPurchaseCheck =
  | { allowed: true; remainingLamports: bigint; ceilingLamports: bigint }
  | { allowed: false; rejection: NftPurchaseRejection }

/** Advisory mirror of `nft_purchase_rules::authorize_purchase`. Precedence matches the program. */
export function checkNftPurchaseAuthorization(input: {
  authorization: NftPurchaseAuthorizationState
  mandate: string
  owner: string
  executor: string
  marketplace: string
  priceLamports: bigint
  nowSeconds: number
}): NftPurchaseCheck {
  const { authorization, mandate, owner, executor, marketplace, priceLamports, nowSeconds } = input
  if (authorization.version !== NFT_PURCHASE_AUTH_VERSION) return { allowed: false, rejection: 'PurchaseAuthorizationMismatch' }
  if (!authorization.active) return { allowed: false, rejection: 'PurchaseAuthorizationNotActive' }
  if (authorization.mandate !== mandate || authorization.owner !== owner
    || authorization.executor !== executor || authorization.marketplace !== marketplace
    || authorization.recipient !== owner) {
    return { allowed: false, rejection: 'PurchaseAuthorizationMismatch' }
  }
  if (nowSeconds > authorization.expiresAt) return { allowed: false, rejection: 'PurchaseAuthorizationExpired' }
  if (priceLamports <= 0n) return { allowed: false, rejection: 'InvalidPrice' }
  const remaining = authorizationRemaining(authorization)
  const ceiling = maxAllowedDebit(priceLamports)
  if (remaining <= 0n) return { allowed: false, rejection: 'PurchaseAuthorizationBudgetExceeded' }
  if (ceiling > remaining) return { allowed: false, rejection: 'PurchaseAuthorizationBudgetExceeded' }
  return { allowed: true, remainingLamports: remaining, ceilingLamports: ceiling }
}

/** Readable explanation of a refused genuine purchase. Never blames the wallet. */
export function explainNftPurchaseRejection(rejection: NftPurchaseRejection): string {
  switch (rejection) {
    case 'PurchaseAuthorizationNotActive':
      return 'Chưa có uỷ quyền mua NFT gốc đang hoạt động. Bạn cần ký một uỷ quyền mua NFT riêng trước.'
    case 'PurchaseAuthorizationExpired':
      return 'Uỷ quyền mua NFT gốc đã hết hạn. Na dừng mua; ký uỷ quyền mới nếu muốn tiếp tục.'
    case 'PurchaseAuthorizationMismatch':
      return 'Uỷ quyền mua NFT gốc không khớp mandate, chủ ví, executor hoặc marketplace. Na không mua.'
    case 'PurchaseAuthorizationBudgetExceeded':
      return 'Giao dịch vượt hạn mức mua NFT gốc bạn đã uỷ quyền. Na không gửi giao dịch và không tự tăng hạn mức.'
    case 'InvalidPurchaseOrder':
      return 'Mã đơn mua NFT không hợp lệ. Na không gửi giao dịch.'
    case 'InvalidListing':
      return 'Listing không khớp với mint đã xác minh. Na không mua.'
    case 'InvalidMarketplaceProgram':
      return 'Chương trình marketplace không phải Tensor đã xác minh. Na không mua.'
    case 'InvalidBuyer':
      return 'Ví nhận NFT không phải chủ mandate. Na không mua.'
    case 'InvalidBuyerTokenAccount':
      return 'Tài khoản nhận NFT không phải ATA của chủ mandate. Na không mua.'
    case 'InvalidTensorAccounts':
      return 'Danh sách tài khoản Tensor BuyLegacy không hợp lệ. Na không mua.'
    case 'InvalidPrice':
      return 'Giá mua NFT không hợp lệ. Na không gửi giao dịch.'
    case 'PurchaseNotDelivered':
      return 'NFT gốc chưa được chuyển vào ví của bạn, nên giao dịch đã bị huỷ toàn bộ. Không có SOL nào bị trừ.'
    case 'VaultDebitExceeded':
      return 'Số SOL bị trừ khỏi Na Vault vượt mức cho phép cho listing này. Giao dịch đã bị huỷ toàn bộ.'
    case 'UnsupportedTokenStandard':
      return 'Chỉ hỗ trợ NFT chuẩn SPL Token cổ điển trên Devnet. Na không mua tài sản này.'
  }
}

const lamportString = z.string().regex(/^(0|[1-9]\d{0,19})$/).refine(value => BigInt(value) <= 18446744073709551615n, 'Lamports exceed u64')

/** `GET /api/mandate/purchase-authorization` - the owner's on-chain purchase policy. */
export const serializedNftPurchaseAuthorizationSchema = z.object({
  address: walletAddressSchema,
  version: z.number().int().positive(),
  mandate: walletAddressSchema,
  owner: walletAddressSchema,
  executor: walletAddressSchema,
  marketplace: walletAddressSchema,
  recipient: walletAddressSchema,
  maxTotalDebitLamports: lamportString,
  spentLamports: lamportString,
  remainingLamports: lamportString,
  expiresAt: z.number().int(),
  active: z.boolean(),
  createdAt: z.number().int(),
  status: z.enum(['ACTIVE', 'REVOKED', 'EXPIRED']),
}).strict()
export type SerializedNftPurchaseAuthorization = z.infer<typeof serializedNftPurchaseAuthorizationSchema>

/** Owner form that becomes the `create_nft_purchase_authorization` transaction. */
export const createNftPurchaseAuthorizationInputSchema = z.object({
  maxTotalDebitSol: z.number().finite().positive().max(10_000),
  expiresInHours: z.number().int().min(1).max(24 * 30),
}).strict()
export type CreateNftPurchaseAuthorizationInput = z.infer<typeof createNftPurchaseAuthorizationInputSchema>

/** One genuine purchase receipt, read back from the program's immutable receipt account. */
export const nftPurchaseReceiptSchema = z.object({
  address: walletAddressSchema,
  version: z.number().int().positive(),
  mandate: walletAddressSchema,
  authorization: walletAddressSchema,
  owner: walletAddressSchema,
  executor: walletAddressSchema,
  mint: walletAddressSchema,
  listing: walletAddressSchema,
  marketplace: walletAddressSchema,
  priceLamports: lamportString,
  totalDebitLamports: lamportString,
  orderId: z.string().regex(/^[0-9a-f]{32}$/),
  timestamp: z.number().int(),
}).strict()
export type NftPurchaseReceipt = z.infer<typeof nftPurchaseReceiptSchema>

/**
 * Result of a genuine purchase attempt. `status` is deliberately separate from any settlement
 * vocabulary: NO_EXECUTABLE_LISTING means nothing was built or sent.
 */
export const nftPurchaseResultSchema = z.object({
  orderId: z.string().regex(/^[0-9a-f]{32}$/),
  status: z.enum(['CONFIRMED', 'FAILED', 'PENDING', 'NOT_SUBMITTED', 'NO_EXECUTABLE_LISTING',
    'AUTHORIZATION_REQUIRED', 'PURCHASE_DISABLED', 'RECONCILIATION_ERROR']),
  deliveryMode: z.literal('ORIGINAL_NFT_TRANSFER'),
  network: z.literal('devnet'),
  marketplace: z.literal('Tensor'),
  mint: walletAddressSchema,
  listing: walletAddressSchema,
  seller: walletAddressSchema,
  priceLamports: lamportString,
  maxTotalDebitLamports: lamportString,
  signature: z.string().nullable(),
  receipt: nftPurchaseReceiptSchema.nullable(),
  delivery: z.object({ owner: walletAddressSchema, mint: walletAddressSchema, tokenAccount: walletAddressSchema,
    signature: z.string(), slot: z.number().int().nonnegative(), commitment: z.literal('finalized'), amount: z.literal('1') }).strict().nullable().default(null),
  rejection: z.enum(NFT_PURCHASE_RESULT_REJECTIONS).nullable(),
  message: z.string().min(1),
}).strict()
export type NftPurchaseResult = z.infer<typeof nftPurchaseResultSchema>

/** Lowercase 32-character hex form of a 16-byte order id, as stored on chain. */
export const orderIdHexSchema = z.string().regex(/^[0-9a-f]{32}$/)

/**
 * The order id is derived in the backend (`nft-purchase/orderIdentity.ts`) because it needs a
 * hashing primitive the browser and extension bundles do not carry. Only its shape is shared.
 */
export function isOrderIdHex(value: string): boolean {
  return orderIdHexSchema.safeParse(value).success
}
