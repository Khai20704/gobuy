// Verifies that the Tensor BuyLegacy constants cannot drift between the three places that carry
// them: the on-chain Rust rules, the shared TypeScript contract and the backend client layout.
// When the official Tensor SDK is installed it is checked too, because the SDK is the source of
// truth those mirrors were decoded from.
//
// Pure static analysis: no network, no wallet, no transaction. Exit code 1 on any mismatch.

import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const read = (relative) => readFileSync(resolve(root, relative), 'utf8')

const failures = []
const checked = []

function assert(condition, message) {
  if (condition) checked.push(message)
  else failures.push(message)
}

function assertEqual(actual, expected, label) {
  assert(actual === expected, `${label}: expected ${expected}, found ${actual}`)
}

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

function base58Encode(bytes) {
  let value = 0n
  for (const byte of bytes) value = value * 256n + BigInt(byte)
  let out = ''
  while (value) { out = ALPHABET[Number(value % 58n)] + out; value /= 58n }
  let zeros = 0
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++
  return '1'.repeat(zeros) + out
}

const hex = (bytes) => Buffer.from(bytes).toString('hex')

/** Extracts `pub const NAME: [u8; N] = [ ... ];` from Rust source as a number array. */
function rustByteArray(source, name) {
  const match = new RegExp(`pub const ${name}: \\[u8; \\d+\\] = \\[([^\\]]*)\\]`).exec(source)
  if (!match) throw new Error(`Could not find the Rust constant ${name}.`)
  return match[1]
    .split(',')
    .map((token) => token.trim())
    .filter((token) => token.length > 0)
    .map((token) => (token.startsWith('0x') ? Number.parseInt(token, 16) : Number.parseInt(token, 10)))
}

function rustUsize(source, name) {
  const match = new RegExp(`pub const ${name}: usize = (\\d+)`).exec(source)
  if (!match) throw new Error(`Could not find the Rust constant ${name}.`)
  return Number.parseInt(match[1], 10)
}

function tsConstant(source, name) {
  const match = new RegExp(`export const ${name}\\s*=\\s*'([^']*)'`).exec(source)
  if (!match) throw new Error(`Could not find the TypeScript constant ${name}.`)
  return match[1]
}

function tsNumber(source, name) {
  const match = new RegExp(`export const ${name}\\s*=\\s*(\\d+)`).exec(source)
  if (!match) throw new Error(`Could not find the TypeScript constant ${name}.`)
  return Number.parseInt(match[1], 10)
}

// ---------------------------------------------------------------- Rust rules
const rustRules = read('anchor/programs/gobuy_na/src/nft_purchase_rules.rs')
const rustTensorProgram = base58Encode(rustByteArray(rustRules, 'TENSOR_MARKETPLACE_PROGRAM'))
const rustTokenProgram = base58Encode(rustByteArray(rustRules, 'SPL_TOKEN_PROGRAM'))
const rustAtaProgram = base58Encode(rustByteArray(rustRules, 'ASSOCIATED_TOKEN_PROGRAM'))
const rustDiscriminator = hex(rustByteArray(rustRules, 'BUY_LEGACY_DISCRIMINATOR'))
const rustAccountCount = rustUsize(rustRules, 'BUY_LEGACY_ACCOUNTS')

const rustIndices = Object.fromEntries(
  ['IX_FEE_VAULT', 'IX_BUYER', 'IX_BUYER_TA', 'IX_LIST_TA', 'IX_LIST_STATE', 'IX_MINT',
    'IX_SELLER', 'IX_PAYER', 'IX_RENT_DESTINATION', 'IX_TOKEN_PROGRAM',
    'IX_ASSOCIATED_TOKEN_PROGRAM', 'IX_MARKETPLACE_PROGRAM', 'IX_SYSTEM_PROGRAM']
    .map((name) => [name, rustUsize(rustRules, name)]))

// ------------------------------------------------------- shared TS contract
const shared = read('shared/src/nftPurchaseAuthorization.ts')
assertEqual(rustTensorProgram, tsConstant(shared, 'TENSOR_MARKETPLACE_PROGRAM_ID'), 'Tensor marketplace program id (Rust vs shared)')
assertEqual(rustDiscriminator, tsConstant(shared, 'TENSOR_BUY_LEGACY_DISCRIMINATOR'), 'buy_legacy discriminator (Rust vs shared)')
assertEqual(rustAccountCount, tsNumber(shared, 'TENSOR_BUY_LEGACY_ACCOUNTS'), 'BuyLegacy account count (Rust vs shared)')

// The discriminator must be the real Anchor one, not a hand-written literal.
const derivedDiscriminator = createHash('sha256').update('global:buy_legacy').digest('hex').slice(0, 16)
assertEqual(rustDiscriminator, derivedDiscriminator, 'buy_legacy discriminator (Rust vs sha256("global:buy_legacy"))')
assertEqual(rustDiscriminator.length, 16, 'buy_legacy discriminator byte length')

// The three fixed program ids must decode to the canonical addresses.
assertEqual(rustTokenProgram, 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'classic SPL Token program id')
assertEqual(rustAtaProgram, 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL', 'associated token program id')

// -------------------------------------------------- backend client layout
const layoutFile = read('backend/src/services/nft-purchase/tensorBuyLegacyLayout.ts')
const layoutNames = [...layoutFile.matchAll(/\{\s*name:\s*'([^']+)',\s*writable:\s*(true|false)\s*\}/g)]
  .map((match) => ({ name: match[1], writable: match[2] === 'true' }))

assertEqual(layoutNames.length, rustAccountCount, 'BuyLegacy account count (Rust vs backend layout)')

// The account that pays and the account that receives the NFT, from the official SDK order.
const EXPECTED_ORDER = ['feeVault', 'buyer', 'buyerTa', 'listTa', 'listState', 'mint', 'owner',
  'payer', 'takerBroker', 'makerBroker', 'rentDestination', 'tokenProgram',
  'associatedTokenProgram', 'marketplaceProgram', 'systemProgram', 'metadata', 'edition',
  'buyerTokenRecord', 'listTokenRecord', 'authorizationRules', 'authorizationRulesProgram',
  'tokenMetadataProgram', 'sysvarInstructions', 'cosigner']
EXPECTED_ORDER.forEach((name, index) => {
  assertEqual(layoutNames[index]?.name, name, `BuyLegacy account ${index}`)
})

assertEqual(layoutNames[rustIndices.IX_FEE_VAULT]?.name, 'feeVault', 'IX_FEE_VAULT points at feeVault')
assertEqual(layoutNames[rustIndices.IX_BUYER]?.name, 'buyer', 'IX_BUYER points at buyer')
assertEqual(layoutNames[rustIndices.IX_BUYER_TA]?.name, 'buyerTa', 'IX_BUYER_TA points at buyerTa')
assertEqual(layoutNames[rustIndices.IX_LIST_STATE]?.name, 'listState', 'IX_LIST_STATE points at listState')
assertEqual(layoutNames[rustIndices.IX_MINT]?.name, 'mint', 'IX_MINT points at mint')
assertEqual(layoutNames[rustIndices.IX_SELLER]?.name, 'owner', 'IX_SELLER points at the listing owner')
assertEqual(layoutNames[rustIndices.IX_PAYER]?.name, 'payer', 'IX_PAYER points at payer')
assertEqual(layoutNames[rustIndices.IX_MARKETPLACE_PROGRAM]?.name, 'marketplaceProgram', 'IX_MARKETPLACE_PROGRAM points at marketplaceProgram')

// The payer slot is the only one the program signs for, and it must be writable so the vault can
// actually be debited. The fee vault may never be the payer or the recipient.
assert(layoutNames[rustIndices.IX_PAYER]?.writable === true, 'BuyLegacy `payer` slot is writable')
assertEqual(rustIndices.IX_PAYER, 7, 'IX_PAYER index')
assert(rustIndices.IX_FEE_VAULT !== rustIndices.IX_PAYER, 'feeVault and payer are different slots')

// Backend layout index constants must agree with the Rust ones it mirrors.
for (const name of ['IX_BUYER', 'IX_BUYER_TA', 'IX_LIST_STATE', 'IX_MINT', 'IX_SELLER', 'IX_PAYER', 'IX_MARKETPLACE_PROGRAM']) {
  assertEqual(tsNumber(layoutFile, name), rustIndices[name], `${name} (Rust vs backend layout)`)
}

// ------------------------------------------------- optional: official SDK
const sdkBundle = 'node_modules/@tensor-foundation/marketplace/dist/src/index.mjs'
if (existsSync(resolve(root, sdkBundle))) {
  const bundle = read(sdkBundle)

  const sdkDiscriminator = /BUY_LEGACY_DISCRIMINATOR = new Uint8Array\(\[([^\]]*)\]\)/.exec(bundle)
  if (!sdkDiscriminator) throw new Error('Could not read BUY_LEGACY_DISCRIMINATOR from the installed Tensor SDK.')
  const sdkBytes = sdkDiscriminator[1].split(',').map((token) => Number.parseInt(token.trim(), 10)).filter(Number.isFinite)
  assertEqual(hex(sdkBytes), rustDiscriminator, 'buy_legacy discriminator (Rust vs installed Tensor SDK)')

  // The SDK declares account order and writability in the `originalAccounts` table of
  // `getBuyLegacyInstruction`. Scope the search to that function: every other instruction in the
  // bundle has a table of the same shape.
  const buyLegacyFunction = bundle.indexOf('function getBuyLegacyInstruction(')
  if (buyLegacyFunction < 0) throw new Error('Could not find getBuyLegacyInstruction in the installed Tensor SDK.')
  const accountsBlock = /const originalAccounts = \{([\s\S]*?)\n  \};/.exec(bundle.slice(buyLegacyFunction))
  if (!accountsBlock) throw new Error('Could not read the BuyLegacy account table from the installed Tensor SDK.')
  // Each entry is `name: { ...isWritable: <bool> ... }` with no nested braces.
  const sdkAccounts = [...accountsBlock[1].matchAll(/(\w+):\s*\{([^{}]*)\}/g)]
    .map((match) => ({ name: match[1], writable: /isWritable:\s*true/.test(match[2]) }))

  sdkAccounts.forEach((account, index) => {
    assertEqual(account.name, EXPECTED_ORDER[index], `Tensor SDK account ${index}`)
  })

  // The SDK table declares the MAXIMUM writability of a slot. Optional slots such as takerBroker,
  // makerBroker, buyerTokenRecord and listTokenRecord are only writable when the listing supplies
  // them, and the backend never trusts a static table for that: it copies the resolved roles off
  // the SDK instruction itself (`tensorRemainingAccounts`). Demanding field-by-field equality with
  // a shape reference would therefore be wrong; check the invariants that actually decide safety.
  for (let index = 0; index < sdkAccounts.length; index++) {
    if (layoutNames[index]?.writable === true) {
      assert(sdkAccounts[index].writable === true,
        `the backend layout must never claim write access the SDK does not declare (account ${index}, ${sdkAccounts[index].name})`)
    }
  }
  assert(sdkAccounts[rustIndices.IX_FEE_VAULT]?.writable === true, 'Tensor SDK declares feeVault writable')
  assert(sdkAccounts[rustIndices.IX_BUYER]?.writable === false, 'Tensor SDK declares buyer read-only')
  assert(sdkAccounts[rustIndices.IX_MINT]?.writable === false, 'Tensor SDK declares mint read-only')
  assert(sdkAccounts[rustIndices.IX_PAYER]?.writable === true, 'Tensor SDK declares payer writable, so the vault can be debited')
  assertEqual(sdkAccounts[rustIndices.IX_PAYER]?.name, 'payer', 'Tensor SDK payer slot matches IX_PAYER')

  const listingDependent = sdkAccounts
    .map((account, index) => ({ ...account, index }))
    .filter((account) => account.writable && layoutNames[account.index]?.writable !== true)
  console.log(`note: the SDK declares ${listingDependent.length} listing-dependent slot(s) writable when a listing supplies them: ${listingDependent.map((account) => account.name).join(', ')}`)
} else {
  console.log('note: the official Tensor SDK is not installed, SDK cross-check skipped')
}

// ------------------------------------------------------------------ report
for (const message of checked) console.log(`ok   ${message}`)
if (failures.length > 0) {
  console.error('\nFAILED:')
  for (const message of failures) console.error(`  - ${message}`)
  console.error(`\n${failures.length} Tensor constant mismatch(es). The Rust program, the shared contract and the backend layout must agree before any purchase is attempted.`)
  process.exit(1)
}
console.log(`\nAll ${checked.length} Tensor constant checks passed.`)
