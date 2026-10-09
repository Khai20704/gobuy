import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { PublicKey } from '@solana/web3.js'
import { InputError } from '../../schemas/search.js'
import { authorizationRemaining,
  type NftPurchaseAuthorizationState, type NftPurchaseReceipt } from '@gobuy/shared'

/**
 * Decoders for the two accounts the genuine-purchase instruction reads and writes.
 *
 * Layouts mirror `NftPurchaseAuthorization` and `NftPurchaseReceipt` in
 * `anchor/programs/gobuy_na/src/nft_purchase.rs`. Any unexpected size or discriminator fails
 * closed: a half-decoded policy must never be treated as authorizing a spend.
 */

const discriminator = (name: string) =>
  createHash('sha256').update('account:' + name).digest('hex').slice(0, 16)

export const NFT_PURCHASE_AUTH_DISCRIMINATOR = discriminator('NftPurchaseAuthorization')
export const NFT_PURCHASE_RECEIPT_DISCRIMINATOR = discriminator('NftPurchaseReceipt')

/** 8 + version(1) + 5 pubkeys + 2 u64 + i64 + bool(1) + i64 + bump(1). */
export const NFT_PURCHASE_AUTH_DATA_SIZE = 203
/** 8 + version(1) + 7 pubkeys + 2 u64 + 16-byte id + i64 + bump(1). */
export const NFT_PURCHASE_RECEIPT_DATA_SIZE = 274

function bufferOf(data: Uint8Array): Buffer {
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength)
}

export type NftPurchaseAuthorizationAccount = NftPurchaseAuthorizationState & { address: string; createdAt: number }

/** Decode `NftPurchaseAuthorization`. Throws for anything the program could not have written. */
export function decodeNftPurchaseAuthorization(address: string, data: Uint8Array): NftPurchaseAuthorizationAccount {
  const buffer = bufferOf(data)
  if (buffer.length !== NFT_PURCHASE_AUTH_DATA_SIZE
    || buffer.subarray(0, 8).toString('hex') !== NFT_PURCHASE_AUTH_DISCRIMINATOR) {
    throw new InputError('Tài khoản uỷ quyền mua NFT on-chain không hợp lệ. Na từ chối giao dịch.')
  }
  const key = (from: number) => new PublicKey(buffer.subarray(from, from + 32)).toBase58()
  return {
    address,
    version: buffer.readUInt8(8),
    mandate: key(9),
    owner: key(41),
    executor: key(73),
    marketplace: key(105),
    recipient: key(137),
    maxTotalDebitLamports: buffer.readBigUInt64LE(169),
    spentLamports: buffer.readBigUInt64LE(177),
    expiresAt: Number(buffer.readBigInt64LE(185)),
    active: buffer.readUInt8(193) === 1,
    createdAt: Number(buffer.readBigInt64LE(194)),
  }
}

export function serializeNftPurchaseAuthorization(account: NftPurchaseAuthorizationAccount) {
  const status = !account.active ? 'REVOKED' as const
    : account.expiresAt < Math.floor(Date.now() / 1000) ? 'EXPIRED' as const : 'ACTIVE' as const
  return {
    address: account.address,
    version: account.version,
    mandate: account.mandate,
    owner: account.owner,
    executor: account.executor,
    marketplace: account.marketplace,
    recipient: account.recipient,
    maxTotalDebitLamports: account.maxTotalDebitLamports.toString(),
    spentLamports: account.spentLamports.toString(),
    remainingLamports: authorizationRemaining(account).toString(),
    expiresAt: account.expiresAt,
    active: account.active,
    createdAt: account.createdAt,
    status,
  }
}

/** Decode `NftPurchaseReceipt`. Throws for anything the program could not have written. */
export function decodeNftPurchaseReceipt(address: string, data: Uint8Array): NftPurchaseReceipt {
  const buffer = bufferOf(data)
  if (buffer.length !== NFT_PURCHASE_RECEIPT_DATA_SIZE
    || buffer.subarray(0, 8).toString('hex') !== NFT_PURCHASE_RECEIPT_DISCRIMINATOR) {
    throw new InputError('Biên nhận mua NFT on-chain không hợp lệ. Na không hiển thị biên nhận này.')
  }
  const key = (from: number) => new PublicKey(buffer.subarray(from, from + 32)).toBase58()
  return {
    address,
    version: buffer.readUInt8(8),
    mandate: key(9),
    authorization: key(41),
    owner: key(73),
    executor: key(105),
    mint: key(137),
    listing: key(169),
    marketplace: key(201),
    priceLamports: buffer.readBigUInt64LE(233).toString(),
    totalDebitLamports: buffer.readBigUInt64LE(241).toString(),
    orderId: buffer.subarray(249, 265).toString('hex'),
    timestamp: Number(buffer.readBigInt64LE(265)),
  }
}
