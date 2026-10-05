// Decode base58 without carrying a wallet SDK into the extension, the frontend or the backend.
const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

export function base58Encode(bytes: Uint8Array): string {
  let value = 0n
  for (const byte of bytes) value = value * 256n + BigInt(byte)
  let result = ''
  while (value) { result = alphabet[Number(value % 58n)] + result; value /= 58n }
  let zeros = 0
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++
  return '1'.repeat(zeros) + result
}

/**
 * Generic base58 decoder. Leading zero bytes are preserved, which is what makes the all-ones
 * System Program address decode to 32 zero bytes.
 */
export function base58Decode(value: string): Uint8Array {
  if (!/^[1-9A-HJ-NP-Za-km-z]+$/.test(value)) throw new Error('Invalid base58 value')
  let n = 0n
  for (const character of value) n = n * 58n + BigInt(alphabet.indexOf(character))
  const bytes: number[] = []
  while (n) { bytes.unshift(Number(n & 255n)); n >>= 8n }
  const leadingZeros = value.length - value.replace(/^1+/, '').length
  return Uint8Array.from([...Array<number>(leadingZeros).fill(0), ...bytes])
}

/** A Solana public key decodes to exactly 32 bytes; anything else is rejected. */
export function publicKeyBytes(value: string): Uint8Array {
  let decoded: Uint8Array
  try { decoded = base58Decode(value) }
  catch { throw new Error('Invalid public key') }
  if (decoded.length !== 32) throw new Error('Invalid public key length')
  return decoded
}
