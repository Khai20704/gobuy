// Confirms that a compiled SBF artifact still carries the existing Devnet program identity.
//
// `declare_id!("...")` writes the program's 32 raw public-key bytes into the program's read-only
// data, so the identity is verifiable straight from the .so without a cluster, a wallet or a
// deployment. Run this after `cargo build-sbf` to prove the build did not silently change the
// program address that the deployed Devnet program and its funded PDAs belong to.
//
// Usage: node scripts/verify-sbf-program-id.mjs <path-to.so> <expected-base58-program-id>

import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

function base58Decode(value) {
  if (!/^[1-9A-HJ-NP-Za-km-z]+$/.test(value)) throw new Error(`Invalid base58 value: ${value}`)
  let n = 0n
  for (const character of value) n = n * 58n + BigInt(ALPHABET.indexOf(character))
  const bytes = []
  while (n) { bytes.unshift(Number(n & 255n)); n >>= 8n }
  const leadingZeros = value.length - value.replace(/^1+/, '').length
  return Buffer.from([...Array(leadingZeros).fill(0), ...bytes])
}

const [artifactPath, expectedProgramId] = process.argv.slice(2)

if (!artifactPath || !expectedProgramId) {
  console.error('Usage: node scripts/verify-sbf-program-id.mjs <path-to.so> <expected-base58-program-id>')
  process.exit(2)
}

const expectedBytes = base58Decode(expectedProgramId)
if (expectedBytes.length !== 32) {
  console.error(`The expected program id must decode to 32 bytes, got ${expectedBytes.length}.`)
  process.exit(2)
}

let artifact
try {
  artifact = readFileSync(artifactPath)
} catch (error) {
  console.error(`Could not read the SBF artifact ${artifactPath}: ${error.message}`)
  process.exit(1)
}

// A Solana SBF program is an ELF64 shared object; a truncated or empty file must not pass.
if (artifact.length === 0 || artifact.subarray(0, 4).compare(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) !== 0) {
  console.error(`${artifactPath} is not an ELF artifact (${artifact.length} bytes). The SBF build did not produce a program.`)
  process.exit(1)
}

const offset = artifact.indexOf(expectedBytes)
if (offset < 0) {
  console.error(`The SBF artifact does not contain the expected program id ${expectedProgramId}.`)
  console.error('The build must not change the deployed program identity or its funded PDAs.')
  process.exit(1)
}

console.log(`artifact        : ${artifactPath}`)
console.log(`size            : ${artifact.length} bytes`)
console.log(`sha256          : ${createHash('sha256').update(artifact).digest('hex')}`)
console.log(`modified        : ${statSync(artifactPath).mtime.toISOString()}`)
console.log(`program id      : ${expectedProgramId}`)
console.log(`id byte offset  : ${offset}`)
console.log('ok   the compiled SBF artifact carries the existing Devnet program identity')
