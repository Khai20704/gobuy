import { mandateInputSchema, proposalSchema, type CommerceProposal, type MandateInput } from './contracts.js'

const encoder = new TextEncoder()
export const assetCode = (value: string) => value === 'NFT' ? 1 : 2
export const marketCode = (value: string) => value === 'DEMO_MARKET' ? 1 : 2
export function concat(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((size, part) => size + part.length, 0))
  let offset = 0
  for (const part of parts) { result.set(part, offset); offset += part.length }
  return result
}
export function integerLE(value: bigint): Uint8Array {
  const bytes = new Uint8Array(8)
  new DataView(bytes.buffer).setBigUint64(0, BigInt.asUintN(64, value), true)
  return bytes
}
export const hex = (bytes: Uint8Array) => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
export function fromHex(value: string): Uint8Array {
  if (!/^(?:[a-f0-9]{2})+$/i.test(value)) throw new Error('Invalid hex')
  return Uint8Array.from(value.match(/../g)!, byte => parseInt(byte, 16))
}
export const uuidBytes = (id: string) => fromHex(proposalSchema.shape.id.parse(id).replaceAll('-', ''))
export async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', new Uint8Array(bytes).buffer))
}
export const hashText = (value: string) => sha256(encoder.encode(value))

// Domain-separated, fixed-width encoding, identical to Rust. No prompt or reference image.
export async function canonicalProposal(input: CommerceProposal) {
  const p = proposalSchema.parse(input)
  const assetIdHash = await hashText(p.assetId)
  const evidenceHash = await hashText(JSON.stringify([
    p.sellerEvidence.source, p.sellerEvidence.claimedVerified,
    p.sellerEvidence.reference, p.sellerEvidence.disclaimer,
  ]))
  const metadataHash = await hashText(JSON.stringify([
    p.title, p.metadata.imageUrl, p.metadata.description, p.metadata.demo,
  ]))
  const proposalId = uuidBytes(p.id)
  const bytes = concat(encoder.encode('gobuy:proposal:v1'), proposalId, integerLE(BigInt(p.amount)),
    Uint8Array.of(1, assetCode(p.assetType), marketCode(p.marketplace), Number(p.sellerEvidence.claimedVerified)),
    assetIdHash, evidenceHash, metadataHash, integerLE(BigInt(p.expiresAt)))
  return { proposalId, assetIdHash, evidenceHash, metadataHash, hash: await sha256(bytes), bytes }
}
export function canonicalPolicy(input: MandateInput): Uint8Array {
  const { maxAmount, assetType, marketplace, requireVerifiedSeller, autonomy } = input
  const m = mandateInputSchema.parse({ maxAmount, assetType, marketplace, requireVerifiedSeller, autonomy })
  return concat(encoder.encode('gobuy:policy:v1'), integerLE(BigInt(m.maxAmount)),
    Uint8Array.of(1, assetCode(m.assetType), marketCode(m.marketplace), Number(m.requireVerifiedSeller), Number(m.autonomy)))
}
export const policyHash = (m: MandateInput) => sha256(canonicalPolicy(m))
export function formatAmount(value: string): string {
  const units = BigInt(value)
  return (units / 1000000000n).toString() + '.' + (units % 1000000000n).toString().padStart(9, '0').replace(/0+$/, '').padEnd(1, '0')
}
