import { z } from 'zod'
import { walletAddressSchema } from './acquisition.js'

/**
 * Shared contract for the Na Vault spending mandate.
 *
 * The Anchor program is the final authority. These helpers exist so the UI can show the same
 * budget arithmetic and translate an on-chain rejection into a readable message. Nothing in this
 * file can authorize a spend: it is a mirror of `anchor/programs/gobuy_na/src/mandate_rules.rs`.
 */

export const mandateCategorySchema = z.enum(['ANY', 'NFT', 'RWA'])
export type MandateCategory = z.infer<typeof mandateCategorySchema>

/** Codes match `mandate_rules::CATEGORY_*` and are what the program stores on chain. */
export const MANDATE_CATEGORY_CODE: Readonly<Record<MandateCategory, number>> = Object.freeze({ ANY: 0, NFT: 1, RWA: 2 })
const CATEGORY_BY_CODE: Readonly<Record<number, MandateCategory>> = Object.freeze({ 0: 'ANY', 1: 'NFT', 2: 'RWA' })

export function mandateCategoryFromCode(code: number): MandateCategory {
  const category = CATEGORY_BY_CODE[code]
  if (!category) throw new Error('Unknown mandate category code: ' + code)
  return category
}

/** Human label for a mandate category, used in messages the owner reads. */
export function categoryLabel(category: MandateCategory): string {
  return category === 'ANY' ? 'NFT và RWA' : category
}

/**
 * The rule the Anchor program enforces in `mandate_rules::authorize_spend`: ANY permits both
 * categories, otherwise the requested category must match the mandate exactly. NFT and RWA never
 * cross: an NFT mandate cannot buy RWA and a RWA mandate cannot buy NFT.
 */
export function mandateCategoryAllows(allowed: MandateCategory, requested: Exclude<MandateCategory, 'ANY'>): boolean {
  return allowed === 'ANY' || allowed === requested
}

/** Every way a spend or an owner action can be refused, in the program's own vocabulary. */
export const MANDATE_REJECTIONS = ['MandateNotActive', 'MandateExpired', 'BudgetExceeded', 'InsufficientVaultBalance',
  'InvalidOwner', 'InvalidVault', 'InvalidCategory', 'InvalidAmount', 'AmountOverflow', 'InvalidSpendId',
  'MandateStillActive', 'TransactionFailed'] as const
export type MandateRejection = typeof MANDATE_REJECTIONS[number]

/**
 * Anchor numbers a custom error as 6000 + enum index. The order below matches `NaError` in
 * `lib.rs`; the client uses it to recover the precise reason instead of a generic failure.
 */
export const PROGRAM_ERROR_OFFSET = 6000
export function mandateRejectionFromProgramError(code: number): MandateRejection | undefined {
  const index = code - PROGRAM_ERROR_OFFSET
  return index >= 0 ? MANDATE_REJECTIONS[index] : undefined
}

/** Rent-exempt minimum for a zero-data system account: the floor the vault must always keep. */
export const RENT_EXEMPT_MINIMUM_LAMPORTS = 890_880n

export const LAMPORTS_PER_SOL_UNITS = 1_000_000_000n

/** PDA seeds, identical to `MANDATE_SEED` / `VAULT_SEED` / `SPEND_SEED` in the program. */
export const MANDATE_SEED = 'mandate'
export const VAULT_SEED = 'vault'
export const SPEND_SEED = 'spend'

export type MandateState = {
  address: string
  owner: string
  executor: string
  vault: string
  recipient: string
  maxBudgetLamports: bigint
  spentLamports: bigint
  expiresAt: number
  allowedCategory: MandateCategory
  active: boolean
  closed: boolean
  createdAt: number
  closedAt: number
}

export type MandateStatus = 'ACTIVE' | 'EXPIRED' | 'REVOKED' | 'CLOSED'

export type MandateView = MandateState & {
  /** Lamports actually sitting in the vault right now, read from the chain. */
  vaultLamports: bigint
  remainingLamports: bigint
  status: MandateStatus
}

export function remainingBudget(maxBudgetLamports: bigint, spentLamports: bigint): bigint {
  return maxBudgetLamports > spentLamports ? maxBudgetLamports - spentLamports : 0n
}

/** Lamports the vault may release without dropping below the rent floor. */
export function spendableVaultLamports(vaultLamports: bigint, rentFloor = RENT_EXEMPT_MINIMUM_LAMPORTS): bigint {
  return vaultLamports > rentFloor ? vaultLamports - rentFloor : 0n
}

export function mandateStatus(state: Pick<MandateState, 'active' | 'closed' | 'expiresAt'>, nowSeconds: number): MandateStatus {
  if (state.closed) return 'CLOSED'
  if (!state.active) return 'REVOKED'
  return state.expiresAt < nowSeconds ? 'EXPIRED' : 'ACTIVE'
}

export function toMandateView(state: MandateState, vaultLamports: bigint, nowSeconds: number): MandateView {
  return { ...state, vaultLamports, remainingLamports: remainingBudget(state.maxBudgetLamports, state.spentLamports),
    status: mandateStatus(state, nowSeconds) }
}

export type SpendCheck =
  | { allowed: true; spentAfter: bigint; remainingAfter: bigint }
  | { allowed: false; rejection: MandateRejection }

/**
 * Advisory mirror of `mandate_rules::authorize_spend`. Used to explain a decision before it is
 * attempted and to show the same precedence the program enforces.
 */
export function checkMandateSpend(input: {
  mandate: Pick<MandateState, 'active' | 'closed' | 'expiresAt' | 'allowedCategory' | 'maxBudgetLamports' | 'spentLamports'>
  amountLamports: bigint
  category: Exclude<MandateCategory, 'ANY'>
  nowSeconds: number
  vaultLamports: bigint
  rentFloor?: bigint
}): SpendCheck {
  const { mandate, amountLamports, category, nowSeconds, vaultLamports, rentFloor = RENT_EXEMPT_MINIMUM_LAMPORTS } = input
  if (mandate.spentLamports > mandate.maxBudgetLamports || mandate.maxBudgetLamports > 18446744073709551615n) return { allowed: false, rejection: 'AmountOverflow' }
  if (mandate.closed || !mandate.active) return { allowed: false, rejection: 'MandateNotActive' }
  if (mandate.expiresAt < nowSeconds) return { allowed: false, rejection: 'MandateExpired' }
  if (amountLamports <= 0n) return { allowed: false, rejection: 'InvalidAmount' }
  if (mandate.allowedCategory !== 'ANY' && mandate.allowedCategory !== category) return { allowed: false, rejection: 'InvalidCategory' }
  const remaining = remainingBudget(mandate.maxBudgetLamports, mandate.spentLamports)
  if (amountLamports > remaining) return { allowed: false, rejection: 'BudgetExceeded' }
  if (amountLamports > spendableVaultLamports(vaultLamports, rentFloor)) return { allowed: false, rejection: 'InsufficientVaultBalance' }
  const spentAfter = mandate.spentLamports + amountLamports
  return { allowed: true, spentAfter, remainingAfter: remainingBudget(mandate.maxBudgetLamports, spentAfter) }
}

export function formatSol(lamports: bigint, decimals = 3): string {
  const negative = lamports < 0n
  const value = negative ? -lamports : lamports
  const whole = value / LAMPORTS_PER_SOL_UNITS
  const fraction = (value % LAMPORTS_PER_SOL_UNITS).toString().padStart(9, '0').slice(0, decimals)
  return (negative ? '-' : '') + whole.toString() + (decimals > 0 ? '.' + fraction : '')
}

/** Validation used before the owner signs the funding transaction. */
export const createMandateInputSchema = z.object({
  budgetSol: z.number().finite().positive().max(10_000),
  expiresInHours: z.number().int().min(1).max(24 * 30),
  category: z.enum(['ANY', 'NFT', 'RWA']),
}).strict()
export type CreateMandateInput = z.infer<typeof createMandateInputSchema>

export function solToLamports(value: number): bigint {
  if (!Number.isFinite(value) || value <= 0) throw new Error('Mandate budget must be greater than 0 SOL.')
  const rounded = Math.round(value * 1_000_000_000)
  if (!Number.isSafeInteger(rounded)) throw new Error('SOL amount exceeds safe integer precision.')
  const lamports = BigInt(rounded)
  if (lamports <= 0n) throw new Error('Mandate budget is below one lamport.')
  return lamports
}

/**
 * Readable explanation of a refused spend. Deliberately never asks the user to reconnect Phantom:
 * an on-chain mandate rejection is not a wallet problem.
 */
export function explainMandateRejection(rejection: MandateRejection, context: { amountLamports?: bigint; remainingLamports?: bigint; mandateCategory?: MandateCategory; requestedCategory?: Exclude<MandateCategory, 'ANY'> } = {}): string {
  const amount = context.amountLamports !== undefined ? formatSol(context.amountLamports) : undefined
  const remaining = context.remainingLamports !== undefined ? formatSol(context.remainingLamports) : undefined
  switch (rejection) {
    case 'MandateNotActive':
      return 'Mandate đã bị thu hồi. Na không thể chi tiêu cho đến khi bạn ủy quyền ngân sách mới.'
    case 'MandateExpired':
      return 'Mandate đã hết hạn. Na dừng chi tiêu; bạn cần ủy quyền một mandate mới nếu muốn tiếp tục.'
    case 'BudgetExceeded':
      return 'Na không thể thực hiện giao dịch.\n\nGiá: ' + (amount ?? '?') + ' SOL\nNgân sách còn lại: ' + (remaining ?? '?') +
        ' SOL\n\nGiao dịch vượt quá hạn mức đã ủy quyền. Na chưa gửi giao dịch và không tự tăng hạn mức.'
    case 'InsufficientVaultBalance':
      return 'Na Vault không còn đủ SOL cho giao dịch này. Na chỉ được dùng số SOL bạn đã nạp vào vault.'
    case 'InvalidCategory': {
      const allowed = context.mandateCategory, requested = context.requestedCategory
      if (allowed && allowed !== 'ANY' && requested) {
        return 'Mandate bạn đã ký chỉ cho phép mua ' + categoryLabel(allowed) + ', nhưng yêu cầu này là ' + categoryLabel(requested) +
          '. Na không mua chéo danh mục. Muốn đổi, hãy thu hồi mandate hiện tại rồi ký mandate cho ' + categoryLabel(requested) + '.'
      }
      return 'Danh mục tài sản này không nằm trong mandate bạn đã ủy quyền.'
    }
    case 'InvalidOwner':
      return 'Chỉ chủ ví đã tạo mandate mới thu hồi hoặc rút số SOL còn lại.'
    case 'InvalidVault':
      return 'Tài khoản vault không khớp với mandate. Giao dịch không được gửi.'
    case 'InvalidAmount':
      return 'Số tiền không hợp lệ. Na không gửi giao dịch.'
    case 'AmountOverflow':
      return 'Số tiền vượt giới hạn an toàn của chương trình. Na không gửi giao dịch.'
    case 'InvalidSpendId':
      return 'Mã giao dịch chi tiêu không hợp lệ.'
    case 'MandateStillActive':
      return 'Mandate vẫn đang hoạt động. Hãy thu hồi mandate trước khi rút số SOL còn lại.'
    case 'TransactionFailed':
      return 'Giao dịch không hoàn tất trên Solana Devnet. Không có khoản chi nào được ghi nhận.'
  }
}

/**
 * Na must never confuse the wallet balance with its own spending authority.
 * `walletLamports` is what the user holds; the autonomous budget is the mandate's remaining amount.
 */
export function describeBudgets(walletLamports: bigint | null, mandateRemainingLamports: bigint | null): string {
  const autonomous = mandateRemainingLamports === null
    ? 'Na chưa có ngân sách tự động nào. Bạn cần ủy quyền một mandate trước.'
    : 'Ngân sách tự động của Na là ' + formatSol(mandateRemainingLamports) + ' SOL.'
  const wallet = walletLamports === null ? '' : ' Số dư ví Phantom của bạn là ' + formatSol(walletLamports) +
    ' SOL, nhưng Na không thể sử dụng phần ngoài vault.'
  return autonomous + wallet
}
/**
 * API contract for the Na Vault mandate endpoints.
 *
 * Everything the frontend receives about a mandate is validated with these schemas. A rejection
 * from the program is surfaced as `rejection`, never as a Phantom/wallet problem: an on-chain
 * mandate error is not fixed by reconnecting a wallet.
 */

const lamportString = z.string().regex(/^(0|[1-9]\d{0,19})$/).refine(value => BigInt(value) <= 18446744073709551615n, 'Lamports exceed u64')
const signatureSchema = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{43,88}$/, 'Not a Solana transaction signature')

export const mandateStatusSchema = z.enum(['ACTIVE', 'EXPIRED', 'REVOKED', 'CLOSED'])
/** The structured reason a transaction was refused, so the UI never has to guess from prose. */
export const mandateRejectionSchema = z.enum(MANDATE_REJECTIONS)

export const serializedMandateSchema = z.object({
  address: walletAddressSchema,
  owner: walletAddressSchema,
  executor: walletAddressSchema,
  vault: walletAddressSchema,
  recipient: walletAddressSchema,
  maxBudgetLamports: lamportString,
  spentLamports: lamportString,
  remainingLamports: lamportString,
  vaultLamports: lamportString,
  expiresAt: z.number().int(),
  allowedCategory: mandateCategorySchema,
  active: z.boolean(),
  closed: z.boolean(),
  createdAt: z.number().int(),
  closedAt: z.number().int(),
  status: mandateStatusSchema,
}).strict()
export type SerializedMandateView = z.infer<typeof serializedMandateSchema>

/** `GET /api/mandate` - the owner's mandate plus Na's own description of its budget. */
export const mandateQueryResponseSchema = z.object({
  description: z.string(),
  mandate: serializedMandateSchema.nullable(),
  vaultProgramId: walletAddressSchema.nullable(),
  marketplaceExecution: z.literal('wallet_signature_required'),
}).strict()
export type MandateQueryResponse = z.infer<typeof mandateQueryResponseSchema>

/** One autonomous vault spend, read back from the program's immutable receipt account. */
export const mandateSpendRecordSchema = z.object({
  address: walletAddressSchema,
  mandate: walletAddressSchema,
  owner: walletAddressSchema,
  recipient: walletAddressSchema,
  spendId: z.string().regex(/^[0-9a-f]{32}$/),
  assetHash: z.string().regex(/^[0-9a-f]{64}$/),
  amountLamports: lamportString,
  spentBeforeLamports: lamportString,
  spentAfterLamports: lamportString,
  remainingAfterLamports: lamportString,
  category: mandateCategorySchema,
  timestamp: z.number().int(),
  reference: z.string().max(120).nullable(),
  signature: signatureSchema.nullable().optional(),
}).strict()
export type MandateSpendRecord = z.infer<typeof mandateSpendRecordSchema>

export const mandateSpendsResponseSchema = z.object({ spends: z.array(mandateSpendRecordSchema).max(200) }).strict()
export type MandateSpendsResponse = z.infer<typeof mandateSpendsResponseSchema>

/** The owner-signed setup / revoke / reclaim transaction, returned unsigned for Phantom. */
export const mandateOwnerActions = ['create', 'revoke', 'withdraw'] as const
export const mandateOwnerActionSchema = z.enum(mandateOwnerActions)
export type MandateOwnerAction = z.infer<typeof mandateOwnerActionSchema>

export const unsignedMandateTransactionSchema = z.object({
  action: mandateOwnerActionSchema,
  owner: walletAddressSchema,
  mandate: walletAddressSchema,
  vault: walletAddressSchema,
  transaction: z.string().min(32).max(40000),
  expiresAt: z.iso.datetime(),
  summary: z.string().min(1).max(600),
}).strict()
export type UnsignedMandateTransaction = z.infer<typeof unsignedMandateTransactionSchema>

export const mandateSubmitResponseSchema = z.object({
  action: mandateOwnerActionSchema,
  signature: signatureSchema.nullable(),
  status: z.enum(['CONFIRMED', 'FAILED', 'PENDING']),
  rejection: mandateRejectionSchema.nullable(),
  message: z.string().min(1),
  mandate: serializedMandateSchema.nullable(),
}).strict()
export type MandateSubmitResponse = z.infer<typeof mandateSubmitResponseSchema>

/** Na's autonomous vault spend. The fee payer is GoBuy's Devnet agent, never the owner's wallet. */
export const mandateSpendRequestSchema = z.object({
  owner: walletAddressSchema,
  amountLamports: z.string().regex(/^[1-9]\d{0,15}$/),
  category: z.enum(['NFT', 'RWA']),
  assetHash: z.string().regex(/^[a-f0-9]{64}$/),
  reference: z.string().trim().min(1).max(120),
}).strict()
export type MandateSpendRequest = z.infer<typeof mandateSpendRequestSchema>

export const mandateSpendResponseSchema = z.object({
  signature: signatureSchema.nullable(),
  status: z.enum(['CONFIRMED', 'FAILED', 'PENDING']),
  rejection: mandateRejectionSchema.nullable(),
  message: z.string().min(1),
  spend: mandateSpendRecordSchema.nullable(),
  mandate: serializedMandateSchema.nullable(),
}).strict()
export type MandateSpendResponse = z.infer<typeof mandateSpendResponseSchema>

/** The owner's authorization form -> the create transaction. */
export const mandateAuthorizationSchema = createMandateInputSchema
export type MandateAuthorization = z.infer<typeof mandateAuthorizationSchema>

/** Duration choices the UI offers; `expiresInHours` is validated by `createMandateInputSchema`. */
export const MANDATE_DURATION_PRESETS: ReadonlyArray<{ id: string; label: string; hours: number }> = Object.freeze([
  { id: 'session', label: '12 giờ', hours: 12 },
  { id: 'day', label: '24 giờ', hours: 24 },
  { id: 'week', label: '7 ngày', hours: 24 * 7 },
])
/** `GET /api/mandate/config` - what Na Vault can actually do on this deployment. */
export const mandateConfigResponseSchema = z.object({
  vaultProgramId: walletAddressSchema.nullable(),
  /** True only when the program, Devnet agent and fixed demo recipient are configured. */
  autonomousExecutionReady: z.boolean(),
  categories: z.array(mandateCategorySchema).min(1),
  durations: z.array(z.object({ id: z.string().min(1), label: z.string().min(1), hours: z.number().int().positive() })).min(1),
  marketplaceExecution: z.literal('wallet_signature_required'),
}).strict()
export type MandateConfigResponse = z.infer<typeof mandateConfigResponseSchema>
