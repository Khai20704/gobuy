import { Connection, PublicKey, Transaction, type Keypair, type TransactionInstruction } from '@solana/web3.js'
import {
  base58Encode, assertDevnet, createMandateInputSchema, formatSol, solanaConfig, solToLamports, spendableVaultLamports,
  type MandateCategory, type MandateRejection, type MandateSpendRecord, type MandateSubmitResponse,
  type UnsignedMandateTransaction,
} from '@gobuy/shared'
import { InputError } from '../../schemas/search.js'
import { MandateGuard, mandateProgramId, mandateAddress, serializeMandate, type MandateSnapshot } from './MandateGuard.js'
import { assertExpectedOwnerTransaction, buildOwnerTransaction, ownerInstructionsMatch, ownerTransactionAddresses, type CreateMandateParams, type OwnerAction } from './ownerTransactions.js'
import { explainTransactionFailure, rejectionCodeOf } from './programErrors.js'
import { agentKeypair } from './agentKeypair.js'
import { createMandateComputeBudgetInstructions } from './ownerTransactions.js'
import { readSpendRecords } from './spendRecords.js'

/**
 * Everything the owner does with the Na Vault: authorize and fund it once, then revoke or reclaim.
 *
 * The client retains the exact unsigned message and blockhash expiry for two minutes and
 * compares it with what the wallet signed, so there is nothing to forge between request and send.
 */

/** How long an unsigned owner transaction stays worth signing. */
const OWNER_TRANSACTION_TTL_MS = 120_000

type CreateInput = { budgetSol: number; expiresInHours: number; category: MandateCategory }

export class MandateProgramClient {
  readonly connection: Connection
  private readonly guard: MandateGuard
  private readonly pending = new Map<string, { instructions: TransactionInstruction[]; action: OwnerAction; expires: number; height: number }>()

  constructor(readonly programId: PublicKey, readonly agent: Keypair | undefined,
    readonly settlement: PublicKey | null = settlementAddress(), rpcUrl = solanaConfig(process.env).rpcUrl) {
    this.connection = new Connection(rpcUrl, { commitment: 'confirmed', disableRetryOnRateLimit: true })
    this.guard = new MandateGuard(programId, rpcUrl)
  }

  read(owner: string): Promise<MandateSnapshot | undefined> {
    return this.guard.read(owner)
  }

  /** Immutable spend receipts for the owner's mandate. Receipts survive closing the mandate. */
  async history(owner: string): Promise<Array<Omit<MandateSpendRecord, 'reference'>>> {
    return readSpendRecords(this.connection, this.programId, mandateAddress(this.programId, owner))
  }

  /** Builds the unsigned transaction Phantom shows the user. */
  async ownerTransaction(input: { action: OwnerAction; owner: string; create?: CreateInput }): Promise<UnsignedMandateTransaction> {
    await assertDevnet(this.connection, { network: 'devnet', rpcUrl: this.connection.rpcEndpoint })
    const owner = ownerPublicKey(input.owner)
    const existing = await this.read(input.owner)
    const create = input.action === 'create' ? resolveCreateParams(input.create, existing, this.settlement, this.agent?.publicKey) : undefined
    if (input.action !== 'create') assertActionable(input.action, existing)
    const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash('confirmed')
    const transaction = buildOwnerTransaction(this.programId, input.action, owner, blockhash, lastValidBlockHeight, create)
    for (const [key, entry] of this.pending) if (entry.expires < Date.now()) this.pending.delete(key)
    if (this.pending.size >= 1000) throw new InputError('Too many pending transactions.')
    // Return the original instruction; retain the exact final message the client must sign.
    const expected = new Transaction({ feePayer: owner, blockhash, lastValidBlockHeight })
      .add(...(input.action === 'create' ? createMandateComputeBudgetInstructions() : []), ...transaction.instructions)
    this.pending.set(owner.toBase58() + ':' + blockhash, { instructions: expected.instructions, action: input.action, expires: Date.now() + OWNER_TRANSACTION_TTL_MS, height: lastValidBlockHeight })
    return {
      action: input.action,
      owner: owner.toBase58(),
      ...ownerTransactionAddresses(this.programId, owner),
      transaction: Buffer.from(transaction.serialize({ requireAllSignatures: false, verifySignatures: false })).toString('base64'),
      expiresAt: new Date(Date.now() + OWNER_TRANSACTION_TTL_MS).toISOString(),
      summary: describeOwnerAction(input.action, create),
    }
  }

  /** Refuses anything that is not exactly the mandate action the owner requested. */
  async submitOwnerTransaction(input: { action: OwnerAction; owner: string; transaction: string }): Promise<MandateSubmitResponse> {
    const owner = ownerPublicKey(input.owner)
    const existing = await this.read(input.owner)
    if (input.action !== 'create') assertActionable(input.action, existing)
    const submitted = parseSignedTransaction(input.transaction)
    const pending = this.pending.get(owner.toBase58() + ':' + submitted.recentBlockhash)
    // Phantom injects zero-account ComputeBudget instructions while signing, so the signed result is
    // compared as instructions rather than raw bytes: the mandated instructions must be identical and
    // only wallet ComputeBudget configuration may be added.
    if (!pending || pending.action !== input.action || pending.expires < Date.now() ||
      !ownerInstructionsMatch(pending.instructions, submitted.instructions)) {
      throw new InputError('Transaction changed or expired. Build and sign again.')
    }
    assertExpectedOwnerTransaction(submitted, pending.instructions, owner)
    submitted.lastValidBlockHeight = pending.height
    const refundable = input.action === 'create' || !existing ? 0n : await this.refundableLamports(existing, input.action === 'withdraw')
    let signature: string
    try {
      signature = await this.broadcast(submitted)
    } catch (error) {
      if (rejectionCodeOf(error)) return this.failed(input.action, owner, error, null)
      return { action: input.action, signature: submitted.signature ? base58Encode(submitted.signature) : null, status: 'PENDING', rejection: null,
        message: 'Chưa xác định được kết quả gửi giao dịch. Kiểm tra Explorer và ngân sách trước khi tạo giao dịch mới.', mandate: serializeMandate(existing) }
    }
    let confirmation: readonly string[] | null
    try { confirmation = await this.confirm(signature, submitted.recentBlockhash, submitted.lastValidBlockHeight) }
    catch { return { action: input.action, signature, status: 'PENDING', rejection: null, message: 'Đang chờ xác nhận. Kiểm tra Explorer và ngân sách trước khi gửi lại.', mandate: serializeMandate(existing) } }
    if (confirmation) return this.failed(input.action, owner, { logs: confirmation }, signature)
    return { action: input.action, signature, status: 'CONFIRMED', rejection: null,
      message: describeConfirmation(input.action, refundable), mandate: serializeMandate(await this.read(input.owner)) }
  }

  /** Broadcasts only on verified Devnet. The executor signs spends; the vault PDA signs the CPI. */
  async broadcast(transaction: Transaction): Promise<string> {
    await assertDevnet(this.connection, { network: 'devnet', rpcUrl: this.connection.rpcEndpoint })
    return this.connection.sendRawTransaction(transaction.serialize(), {
      skipPreflight: false, maxRetries: 3, preflightCommitment: 'confirmed',
    })
  }

  /** Resolves to the failed-program logs, or `null` when the transaction succeeded. */
  async confirm(signature: string, blockhash?: string, lastValidBlockHeight?: number): Promise<readonly string[] | null> {
    if (!blockhash || lastValidBlockHeight === undefined) throw new InputError('Missing blockhash expiry; transaction status unknown.')
    const height = lastValidBlockHeight
    const result = await this.connection.confirmTransaction({ signature, blockhash: blockhash ?? '', lastValidBlockHeight: height }, 'confirmed')
    if (!result.value.err) return null
    const confirmed = await this.connection.getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 })
    return confirmed?.meta?.logMessages ?? []
  }

  private async failed(action: OwnerAction, owner: PublicKey, error: unknown, signature: string | null): Promise<MandateSubmitResponse> {
    return { action, signature, status: 'FAILED', rejection: rejectionCodeOf(error) ?? 'TransactionFailed',
      message: explainTransactionFailure(error), mandate: serializeMandate(await this.read(owner.toBase58())) }
  }

  private async refundableLamports(mandate: MandateSnapshot, includeRent = false): Promise<bigint> {
    const balance = BigInt(await this.connection.getBalance(new PublicKey(mandate.vault), 'confirmed'))
    return includeRent ? balance : spendableVaultLamports(balance)
  }
}

function resolveCreateParams(input: CreateInput | undefined, existing: MandateSnapshot | undefined, settlement: PublicKey | null, executor?: PublicKey): CreateMandateParams {
  if (!executor) throw new InputError('Configure the Devnet agent before creating a mandate.')
  const parsed = createMandateInputSchema.safeParse(input)
  if (!parsed.success) throw new InputError('Thông tin ủy quyền ngân sách không hợp lệ. Kiểm tra mức SOL, thời hạn và danh mục.')
  if (!settlement) throw new InputError('Thanh toán demo Devnet chưa sẵn sàng. Vui lòng thử lại sau.')
  if (existing?.status === 'EXPIRED') {
    throw new InputError('Mandate cũ đã hết hạn. Rút số dư và đóng mandate trước khi tạo mandate mới.')
  }
  if (existing) {
    throw new InputError('Ví này đang có một mandate. Thu hồi, rút số dư và đóng mandate trước khi tạo mandate mới.')
  }
  const recipient = settlement
  return { maxBudgetLamports: solToLamports(parsed.data.budgetSol),
    expiresAt: Math.floor(Date.now() / 1000) + parsed.data.expiresInHours * 3600,
    category: parsed.data.category, recipient, executor }
}

function assertActionable(action: OwnerAction, existing: MandateSnapshot | undefined) {
  if (!existing) throw new InputError('Ví này chưa có mandate trên Solana Devnet. Hãy ủy quyền ngân sách cho Na trước.')
  if (action === 'revoke' && existing.status !== 'ACTIVE' && existing.status !== 'EXPIRED') {
    throw new InputError('Mandate này đã bị thu hồi trước đó. Na không gửi giao dịch trùng.')
  }
  if (action === 'withdraw' && existing.status === 'ACTIVE') {
    throw new InputError('Mandate vẫn đang hoạt động. Hãy thu hồi mandate trước khi rút số SOL còn lại.')
  }
}

function ownerPublicKey(value: string): PublicKey {
  try {
    const key = new PublicKey(value)
    if (!PublicKey.isOnCurve(key.toBytes())) throw new Error('not on curve')
    return key
  } catch { throw new InputError('Địa chỉ ví không hợp lệ hoặc không phải ví Solana.') }
}

function parseSignedTransaction(value: string): Transaction {
  try { return Transaction.from(Buffer.from(value, 'base64')) }
  catch { throw new InputError('Giao dịch đã ký không đọc được. Na không gửi giao dịch.') }
}

function describeOwnerAction(action: OwnerAction, create?: CreateMandateParams): string {
  if (action === 'create' && create) {
    return 'Ủy quyền ' + formatSol(create.maxBudgetLamports) + ' SOL cho Na Vault (danh mục ' + create.category +
      '). Giao dịch chuyển đúng số SOL này vào vault do chương trình kiểm soát; phần còn lại trong ví Phantom của bạn không nằm trong hạn mức.'
  }
  if (action === 'revoke') return 'Thu hồi mandate: Na dừng mọi chi tiêu và số SOL còn lại trong vault được trả về ví của bạn.'
  return 'Rút số SOL còn lại trong vault về ví của bạn và đóng mandate.'
}

function describeConfirmation(action: OwnerAction, refundableLamports: bigint): string {
  if (action === 'create') return 'Đã thiết lập Na Vault trên Solana Devnet. Na chỉ có thể chi tiêu trong hạn mức đã ủy quyền; ví Phantom của bạn không cấp thêm quyền nào khác.'
  const refund = formatSol(refundableLamports) + ' SOL'
  if (action === 'revoke') return 'Đã thu hồi mandate. Na dừng chi tiêu; ' + refund + ' còn lại đã được trả về ví của bạn.'
  return 'Đã rút ' + refund + ' từ vault về ví của bạn và đóng mandate. Cần ủy quyền mới nếu muốn Na chi tiêu tiếp.'
}

export type { MandateRejection }
/** Fixed backend-owned Devnet recipient; required to create new mandates. */
export const SETTLEMENT_ADDRESS_ENV = 'NA_SETTLEMENT_ADDRESS'

export function settlementAddress(env: NodeJS.ProcessEnv = process.env): PublicKey | null {
  const raw = env[SETTLEMENT_ADDRESS_ENV]?.trim()
  if (!raw) return null
  try {
    const key = new PublicKey(raw)
    if (!PublicKey.isOnCurve(key.toBytes())) throw new Error('not on curve')
    return key
  } catch { throw new InputError('Thanh toán demo Devnet chưa sẵn sàng. Vui lòng thử lại sau.') }
}

/**
 * Fails closed when the vault program is not deployed/configured. A missing Devnet agent is not an
 * error here: the owner can still revoke and reclaim; new mandates and spends need an executor.
 */
export function requiredMandateClient(env: NodeJS.ProcessEnv = process.env): MandateProgramClient {
  const programId = mandateProgramId(env)
  if (!programId) {
    throw new InputError('Chương trình Na Vault chưa được cấu hình (NA_PROGRAM_ID). Na chưa thể kiểm tra hoặc chi tiêu từ mandate; chưa có giao dịch nào được tạo.')
  }
  return new MandateProgramClient(programId, agentKeypair(env), settlementAddress(env), solanaConfig(env).rpcUrl)
}
