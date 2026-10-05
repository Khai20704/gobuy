import { Keypair } from '@solana/web3.js'
import { base58Decode } from '@gobuy/shared'
import { InputError } from '../../schemas/search.js'

/**
 * GoBuy's Devnet fee payer for autonomous vault spends.
 *
 * The owner explicitly authorizes this executor in the mandate. It pays fees and receipt rent;
 * the program still caps transfers to the funded budget and fixed recipient. Keep the key private:
 * compromise can trigger any transfer the active mandate permits, but cannot reach owner wallet funds.
 */

export const AGENT_KEYPAIR_ENV = 'NA_AGENT_KEYPAIR'
const SECRET_KEY_BYTES = 64

function reject(reason: string, cause?: unknown): never {
  // The reason never echoes the supplied value: a malformed secret must not leak into logs.
  throw new InputError(AGENT_KEYPAIR_ENV + ' không hợp lệ (' + reason + '). Na dừng chi tiêu tự động cho đến khi khoá Devnet agent được cấu hình đúng.', { cause })
}

/** Accepts a dedicated agent's `solana-keygen` JSON array or base58 secret. Never an owner key. */
export function parseAgentKeypair(value: string): Keypair {
  const trimmed = value.trim()
  if (!trimmed) reject('giá trị rỗng')
  let secret: Uint8Array
  if (trimmed.startsWith('[')) {
    let parsed: unknown
    try { parsed = JSON.parse(trimmed) }
    catch (cause) { reject('không phải JSON', cause) }
    if (!Array.isArray(parsed) || parsed.length !== SECRET_KEY_BYTES
      || !parsed.every(byte => Number.isInteger(byte) && byte >= 0 && byte <= 255)) {
      reject('mảng JSON phải có đúng 64 byte')
    }
    secret = Uint8Array.from(parsed as number[])
  } else {
    try { secret = base58Decode(trimmed) }
    catch (cause) { reject('không giải mã được base58', cause) }
    if (secret.length !== SECRET_KEY_BYTES) reject('khoá phải dài 64 byte')
  }
  try { return Keypair.fromSecretKey(secret) }
  catch (cause) { reject('khoá không tạo được cặp public/secret hợp lệ', cause) }
}

export function agentKeypair(env: NodeJS.ProcessEnv = process.env): Keypair | undefined {
  const raw = env[AGENT_KEYPAIR_ENV]?.trim()
  return raw ? parseAgentKeypair(raw) : undefined
}

/** Fails closed: no configured agent means Na has no autonomous execution path at all. */
export function requireAgentKeypair(env: NodeJS.ProcessEnv = process.env): Keypair {
  const keypair = agentKeypair(env)
  if (!keypair) {
    throw new InputError('Chưa cấu hình ví agent Devnet (' + AGENT_KEYPAIR_ENV + '). Na chưa thể chi tiêu tự động từ vault; không có giao dịch nào được gửi.')
  }
  return keypair
}
