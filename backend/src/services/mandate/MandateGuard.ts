import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { Connection, PublicKey } from '@solana/web3.js'
import {
  assertDevnet, MANDATE_SEED, VAULT_SEED, checkMandateSpend, explainMandateRejection, mandateCategoryFromCode,
  mandateStatus, remainingBudget, solanaConfig,
  type MandateCategory, type MandateState,
} from '@gobuy/shared'
import { InputError } from '../../schemas/search.js'

/**
 * Read-only verification of the on-chain spending mandate.
 *
 * This guard exists so the AI and the API cannot prepare a purchase the vault would refuse. It is a
 * pre-check only: `spend_from_mandate` re-derives every rule on chain, and a marketplace purchase is
 * still signed by the wallet. Nothing in this file can authorize a spend by itself.
 */

/** Anchor account discriminators: the first 8 bytes of sha256("account:<Name>"). */
export const MANDATE_DISCRIMINATOR = '71d8629fb93f3712'

/**
 * `Mandate` layout: 8-byte discriminator then 3 pubkeys, 2 u64, 3 i64 and 3 u8 flag/bump fields.
 * Kept here so the backend needs no Anchor client dependency.
 */
export const MANDATE_DATA_SIZE = 181
const OFFSET_OWNER = 8
const OFFSET_VAULT = 40
const OFFSET_RECIPIENT = 72
const OFFSET_MAX_BUDGET = 104
const OFFSET_SPENT = 112
const OFFSET_EXPIRES_AT = 120
const OFFSET_CATEGORY = 128
const OFFSET_ACTIVE = 129
const OFFSET_CLOSED = 130
const OFFSET_CREATED_AT = 131
const OFFSET_CLOSED_AT = 139

/** Decode a `Mandate` account. Any unexpected size or discriminator fails closed. */
export function decodeMandateAccount(data: Uint8Array): MandateState {
  const buffer = Buffer.from(data.buffer, data.byteOffset, data.byteLength)
  if (buffer.length !== MANDATE_DATA_SIZE) {
    throw new InputError('Tài khoản mandate on-chain có kích thước không mong đợi. Na từ chối giao dịch.')
  }
  if (buffer.subarray(0, 8).toString('hex') !== MANDATE_DISCRIMINATOR) {
    throw new InputError('Tài khoản on-chain không phải mandate của GoBuy Na. Na từ chối giao dịch.')
  }
  return {
    address: '',
    executor: new PublicKey(buffer.subarray(149, 181)).toBase58(),
    owner: new PublicKey(buffer.subarray(OFFSET_OWNER, OFFSET_VAULT)).toBase58(),
    vault: new PublicKey(buffer.subarray(OFFSET_VAULT, OFFSET_RECIPIENT)).toBase58(),
    recipient: new PublicKey(buffer.subarray(OFFSET_RECIPIENT, OFFSET_MAX_BUDGET)).toBase58(),
    maxBudgetLamports: buffer.readBigUInt64LE(OFFSET_MAX_BUDGET),
    spentLamports: buffer.readBigUInt64LE(OFFSET_SPENT),
    expiresAt: Number(buffer.readBigInt64LE(OFFSET_EXPIRES_AT)),
    allowedCategory: mandateCategoryFromCode(buffer.readUInt8(OFFSET_CATEGORY)),
    active: buffer.readUInt8(OFFSET_ACTIVE) === 1,
    closed: buffer.readUInt8(OFFSET_CLOSED) === 1,
    createdAt: Number(buffer.readBigInt64LE(OFFSET_CREATED_AT)),
    closedAt: Number(buffer.readBigInt64LE(OFFSET_CLOSED_AT)),
  }
}

/** True when the deployment pointer for the mandate program is present. */
export function mandateProgramId(env: NodeJS.ProcessEnv = process.env): PublicKey | undefined {
  const configured = env.NA_PROGRAM_ID?.trim()
  if (!configured) return undefined
  try { const key = new PublicKey(configured); if (key.toBase58() === '11111111111111111111111111111111') return undefined; return key } catch { throw new Error('NA_PROGRAM_ID is not a valid Solana address.') }
}

export function mandateAddress(programId: PublicKey, owner: string): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from(MANDATE_SEED), new PublicKey(owner).toBuffer()], programId)[0]
}

export function mandateVaultAddress(programId: PublicKey, mandate: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from(VAULT_SEED), mandate.toBuffer()], programId)[0]
}

export type MandateSnapshot = MandateState & { vaultLamports: bigint; status: ReturnType<typeof mandateStatus> }

export class MandateGuard {
  private readonly connection: Connection
  constructor(private readonly programId: PublicKey, rpcUrl = solanaConfig(process.env).rpcUrl) {
    this.connection = new Connection(rpcUrl, { commitment: 'confirmed', disableRetryOnRateLimit: true })
  }

  /** `undefined` means the owner has not created a mandate yet. Errors mean the read itself failed. */
  async read(owner: string): Promise<MandateSnapshot | undefined> {
    await assertDevnet(this.connection, { network: 'devnet', rpcUrl: this.connection.rpcEndpoint })
    if (!PublicKey.isOnCurve(new PublicKey(owner).toBytes())) throw new InputError('Địa chỉ ví không hợp lệ.')
    const address = mandateAddress(this.programId, owner)
    const [info, vault] = await Promise.all([
      this.connection.getAccountInfo(address, 'confirmed'),
      this.connection.getAccountInfo(mandateVaultAddress(this.programId, address), 'confirmed'),
    ])
    if (!info) return undefined
    if (!info.owner.equals(this.programId)) throw new InputError('Tài khoản mandate không thuộc chương trình Na Vault. Na từ chối giao dịch.')
    const decoded = decodeMandateAccount(info.data)
    return { ...decoded, address: address.toBase58(), vaultLamports: BigInt(vault?.lamports ?? 0),
      status: mandateStatus(decoded, Math.floor(Date.now() / 1000)) }
  }

  /**
   * Advisory pre-check for vault settlement only. Wallet-signed marketplace purchases are separate
   * and must never claim to consume or be protected by this vault budget.
   */
  async assertSpendAllowed(owner: string, amountLamports: bigint, category: Exclude<MandateCategory, 'ANY'>): Promise<MandateSnapshot> {
    const mandate = await this.read(owner)
    if (!mandate) throw new InputError('Chưa có mandate trên Solana Devnet cho ví này. Hãy ủy quyền ngân sách cho Na trước khi mua.')
    const remaining = remainingBudget(mandate.maxBudgetLamports, mandate.spentLamports)
    const verdict = checkMandateSpend({ mandate, amountLamports, category,
      nowSeconds: Math.floor(Date.now() / 1000), vaultLamports: mandate.vaultLamports })
    if (!verdict.allowed) throw new InputError(explainMandateRejection(verdict.rejection, { amountLamports, remainingLamports: remaining }))
    return mandate
  }

  async snapshot(owner: string) {
    return this.read(owner)
  }
}

/** Indirection so tests can supply a guard without a live RPC endpoint. */
export type MandateGuardFactory = () => MandateGuard

/** Fails closed when the mandate program has not been deployed and configured. */
export function requiredMandateGuard(env: NodeJS.ProcessEnv = process.env): MandateGuard {
  const programId = mandateProgramId(env)
  if (!programId) {
    throw new InputError('Chương trình Na Vault chưa được cấu hình (NA_PROGRAM_ID). Na chưa thể kiểm tra hoặc chi tiêu từ mandate; chưa có giao dịch nào được tạo.')
  }
  return new MandateGuard(programId)
}

/** JSON-safe snapshot: lamports are strings so no precision is lost in transport. */
export function serializeMandate(mandate: MandateSnapshot | undefined) {
  if (!mandate) return null
  return {
    address: mandate.address, owner: mandate.owner, executor: mandate.executor, vault: mandate.vault, recipient: mandate.recipient,
    maxBudgetLamports: mandate.maxBudgetLamports.toString(),
    spentLamports: mandate.spentLamports.toString(),
    remainingLamports: remainingBudget(mandate.maxBudgetLamports, mandate.spentLamports).toString(),
    vaultLamports: mandate.vaultLamports.toString(),
    expiresAt: mandate.expiresAt, allowedCategory: mandate.allowedCategory, active: mandate.active,
    closed: mandate.closed, createdAt: mandate.createdAt, closedAt: mandate.closedAt, status: mandate.status,
  }
}

export type SerializedMandate = NonNullable<ReturnType<typeof serializeMandate>>

/** Na must describe its own autonomous budget, never the wallet balance. */
export function describeMandate(mandate: MandateSnapshot | undefined): string {
  if (!mandate) return 'Ví này chưa ủy quyền ngân sách nào cho Na, nên Na không có hạn mức chi tiêu tự động.'
  const remaining = formatLamports(remainingBudget(mandate.maxBudgetLamports, mandate.spentLamports))
  if (mandate.status === 'EXPIRED') {
    return 'Mandate đã hết hạn. Na dừng chi tiêu; ' + remaining + ' SOL còn lại trong vault có thể được rút về ví.'
  }
  if (mandate.status !== 'ACTIVE') {
    return 'Mandate đã bị thu hồi. Na không thể chi tiêu; số SOL còn lại trong vault vẫn thuộc ví của bạn.'
  }
  return 'Ngân sách tự động còn lại của Na là ' + remaining + ' SOL, dùng được đến ' +
    new Date(mandate.expiresAt * 1000).toLocaleString('vi-VN') + '. Số SOL ngoài vault không nằm trong hạn mức này.'
}

function formatLamports(lamports: bigint): string {
  return (Number(lamports) / 1e9).toFixed(3)
}

/** Exposed for tests: must match the discriminator the compiled program writes. */
export function accountDiscriminator(name: string): string {
  return createHash('sha256').update('account:' + name).digest('hex').slice(0, 16)
}
