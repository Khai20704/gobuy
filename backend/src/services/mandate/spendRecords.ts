import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { Connection, PublicKey } from '@solana/web3.js'
import { SPEND_SEED, mandateCategoryFromCode, type MandateSpendRecord } from '@gobuy/shared'
import { InputError } from '../../schemas/search.js'

/**
 * Reads the immutable `SpendRecord` receipts the program writes for every authorized spend.
 *
 * This is the on-chain half of the transaction history. It carries the authoritative amounts
 * (`spentBefore` / `spentAfter` / `remainingAfter`); the transaction signature and a human label
 * live in the off-chain index, because storing either on chain would be wasted rent.
 */

/** Anchor account discriminator: the first 8 bytes of sha256("account:SpendRecord"). */
export const SPEND_RECORD_DISCRIMINATOR = createHash('sha256').update('account:SpendRecord').digest('hex').slice(0, 16)

/**
 * `SpendRecord` layout: 8-byte discriminator, 3 pubkeys, a 16-byte id, a 32-byte asset hash,
 * 4 u64 amounts, 1 u8 category, 1 i64 timestamp and 1 u8 bump.
 */
export const SPEND_RECORD_DATA_SIZE = 194
const OFFSET_MANDATE = 8
const OFFSET_OWNER = 40
const OFFSET_RECIPIENT = 72
const OFFSET_SPEND_ID = 104
const OFFSET_ASSET_HASH = 120
const OFFSET_AMOUNT = 152
const OFFSET_SPENT_BEFORE = 160
const OFFSET_SPENT_AFTER = 168
const OFFSET_REMAINING_AFTER = 176
const OFFSET_CATEGORY = 184
const OFFSET_TIMESTAMP = 185

/** Decode one `SpendRecord`. Any unexpected size or discriminator fails closed. */
export function decodeSpendRecord(address: string, data: Uint8Array): Omit<MandateSpendRecord, 'reference'> {
  const buffer = Buffer.from(data.buffer, data.byteOffset, data.byteLength)
  if (buffer.length !== SPEND_RECORD_DATA_SIZE) {
    throw new InputError('Bản ghi chi tiêu on-chain có kích thước không mong đợi. Na không hiển thị bản ghi này.')
  }
  if (buffer.subarray(0, 8).toString('hex') !== SPEND_RECORD_DISCRIMINATOR) {
    throw new InputError('Tài khoản on-chain không phải bản ghi chi tiêu của GoBuy Na. Na bỏ qua bản ghi này.')
  }
  return {
    address,
    mandate: new PublicKey(buffer.subarray(OFFSET_MANDATE, OFFSET_OWNER)).toBase58(),
    owner: new PublicKey(buffer.subarray(OFFSET_OWNER, OFFSET_RECIPIENT)).toBase58(),
    recipient: new PublicKey(buffer.subarray(OFFSET_RECIPIENT, OFFSET_SPEND_ID)).toBase58(),
    spendId: buffer.subarray(OFFSET_SPEND_ID, OFFSET_ASSET_HASH).toString('hex'),
    assetHash: buffer.subarray(OFFSET_ASSET_HASH, OFFSET_AMOUNT).toString('hex'),
    amountLamports: buffer.readBigUInt64LE(OFFSET_AMOUNT).toString(),
    spentBeforeLamports: buffer.readBigUInt64LE(OFFSET_SPENT_BEFORE).toString(),
    spentAfterLamports: buffer.readBigUInt64LE(OFFSET_SPENT_AFTER).toString(),
    remainingAfterLamports: buffer.readBigUInt64LE(OFFSET_REMAINING_AFTER).toString(),
    category: mandateCategoryFromCode(buffer.readUInt8(OFFSET_CATEGORY)),
    timestamp: Number(buffer.readBigInt64LE(OFFSET_TIMESTAMP)),
  }
}

/** `["spend", mandate]` prefix is not a valid memcmp filter, so the mandate key is matched directly. */
export const SPEND_RECORD_MANDATE_OFFSET = OFFSET_MANDATE

/**
 * Every receipt for one mandate, newest first. A Devnet RPC that refuses `getProgramAccounts`
 * raises instead of returning an empty list, so the UI never shows "no spending" when the read
 * actually failed.
 */
export async function readSpendRecords(connection: Connection, programId: PublicKey, mandate: PublicKey): Promise<Array<Omit<MandateSpendRecord, 'reference'>>> {
  let accounts: Awaited<ReturnType<Connection['getProgramAccounts']>>
  try {
    accounts = await connection.getProgramAccounts(programId, {
      commitment: 'confirmed',
      filters: [{ memcmp: { offset: SPEND_RECORD_MANDATE_OFFSET, bytes: mandate.toBase58() } }],
    })
  } catch (cause) {
    throw new InputError('Chưa đọc được lịch sử chi tiêu on-chain từ Devnet RPC. Hạn mức và số dư hiển thị vẫn đúng; thử lại sau.', { cause })
  }
  return accounts
    .flatMap(account => {
      try { return [decodeSpendRecord(account.pubkey.toBase58(), account.account.data)] }
      catch { return [] }
    })
    .sort((a, b) => b.timestamp - a.timestamp)
}

export { SPEND_SEED }
