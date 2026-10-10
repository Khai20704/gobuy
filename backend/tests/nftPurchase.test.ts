import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Buffer } from 'node:buffer'
import { Keypair, PublicKey } from '@solana/web3.js'
import { checkNftPurchaseAuthorization, maxAllowedDebit, NFT_AUTH_SEED, PURCHASE_SEED,
  TENSOR_BUY_LEGACY_ACCOUNTS, TENSOR_BUY_LEGACY_DATA_LENGTH, TENSOR_BUY_LEGACY_DISCRIMINATOR,
  TENSOR_MARKETPLACE_PROGRAM_ID, NFT_PURCHASE_AUTH_VERSION,
  type NftPurchaseAuthorizationState } from '@gobuy/shared'
import { NFT_PURCHASE_AUTH_DATA_SIZE, NFT_PURCHASE_AUTH_DISCRIMINATOR, NFT_PURCHASE_RECEIPT_DATA_SIZE,
  NFT_PURCHASE_RECEIPT_DISCRIMINATOR, decodeNftPurchaseAuthorization, decodeNftPurchaseReceipt,
  serializeNftPurchaseAuthorization } from '../src/services/nft-purchase/nftPurchaseAccounts.js'
import { buyNftFromMandateInstruction, createNftPurchaseAuthorizationInstruction,
  nftAuthorizationAddress, purchaseReceiptAddress, NFT_PURCHASE_INSTRUCTIONS } from '../src/services/nft-purchase/nftPurchaseInstructions.js'
import { orderIdFor, orderIdHex, isValidOrderIdHex } from '../src/services/nft-purchase/orderIdentity.js'
import { assertTensorBuyLegacyInstruction, tensorRemainingAccounts, IX_BUYER, IX_BUYER_TA, IX_LIST_STATE,
  IX_MINT, IX_PAYER, IX_SELLER } from '../src/services/nft-purchase/tensorBuyLegacyLayout.js'
import { NftPurchaseService, nftPurchaseLiveEnabled, type NftPurchaseOrder } from '../src/services/nft-purchase/NftPurchaseService.js'
import type { AssetStore } from '../src/persistence/AssetStore.js'
import { demoAutoPurchaseEnabled } from '../src/services/acquisition/AutonomousPurchaseService.js'
import { NFT_PURCHASE_DELIVERY_MODE } from '../src/http/routes/nftPurchase.js'

/**
 * Genuine Devnet NFT purchase invariants.
 *
 * Everything here is host-runnable on purpose: the purchase path must be provably correct about
 * layout, budget arithmetic and fail-closed decoding without a live RPC, because a wrong assumption
 * about any of them spends real SOL from the vault.
 */

const PROGRAM_ID = new PublicKey('CHjdqooB7TrussJoZoboFP5TtdCspoHtvPpqoshbr5zE')
const OWNER = Keypair.generate().publicKey.toBase58()
const EXECUTOR = Keypair.generate().publicKey.toBase58()
const MINT = Keypair.generate().publicKey.toBase58()
const LISTING = Keypair.generate().publicKey.toBase58()
const SELLER = Keypair.generate().publicKey.toBase58()
const PRICE = 40_000_000n
const DISCOVERY = '3f2504e0-4f89-11d3-9a0c-0305e82c3301'
const mandateKey = PublicKey.findProgramAddressSync(
  [Buffer.from('mandate'), new PublicKey(OWNER).toBuffer()], PROGRAM_ID)[0]
const vaultKey = PublicKey.findProgramAddressSync([Buffer.from('vault'), mandateKey.toBuffer()], PROGRAM_ID)[0]

function encodeAuthorization(state: NftPurchaseAuthorizationState): Buffer {
  const buffer = Buffer.alloc(NFT_PURCHASE_AUTH_DATA_SIZE)
  Buffer.from(NFT_PURCHASE_AUTH_DISCRIMINATOR, 'hex').copy(buffer, 0)
  buffer.writeUInt8(state.version, 8)
  const keys = [state.mandate, state.owner, state.executor, state.marketplace, state.recipient]
  keys.forEach((key, index) => new PublicKey(key).toBuffer().copy(buffer, 9 + index * 32))
  buffer.writeBigUInt64LE(state.maxTotalDebitLamports, 169)
  buffer.writeBigUInt64LE(state.spentLamports, 177)
  buffer.writeBigInt64LE(BigInt(state.expiresAt), 185)
  buffer.writeUInt8(state.active ? 1 : 0, 193)
  buffer.writeBigInt64LE(1_700_000_000n, 194)
  buffer.writeUInt8(255, 202)
  return buffer
}

/**
 * The exact 24-account BuyLegacy instruction the official SDK produced for a public SOL listing:
 * absent optionals are the marketplace program id, only `payer` is a signer, and the data is
 * discriminator + maxAmount + two `None`s.
 */
function buyLegacyInstruction(overrides: { payer?: string; price?: bigint; data?: Buffer; accounts?: number } = {}) {
  const accounts = Array.from({ length: TENSOR_BUY_LEGACY_ACCOUNTS }, () => ({
    address: TENSOR_MARKETPLACE_PROGRAM_ID, isSigner: false, isWritable: false }))
  accounts[IX_BUYER] = { address: OWNER, isSigner: false, isWritable: false }
  accounts[IX_BUYER_TA] = { address: OWNER, isSigner: false, isWritable: true }
  accounts[IX_LIST_STATE] = { address: LISTING, isSigner: false, isWritable: true }
  accounts[IX_MINT] = { address: MINT, isSigner: false, isWritable: false }
  accounts[IX_SELLER] = { address: SELLER, isSigner: false, isWritable: true }
  accounts[IX_PAYER] = { address: overrides.payer ?? vaultKey.toBase58(), isSigner: true, isWritable: true }
  const price = Buffer.alloc(8)
  price.writeBigUInt64LE(overrides.price ?? PRICE)
  const data = overrides.data ?? Buffer.concat([Buffer.from(TENSOR_BUY_LEGACY_DISCRIMINATOR, 'hex'), price, Buffer.from([0, 0])])
  return { programAddress: TENSOR_MARKETPLACE_PROGRAM_ID,
    accounts: accounts.slice(0, overrides.accounts ?? accounts.length), data,
    mint: MINT, seller: SELLER, listState: LISTING, priceLamports: PRICE.toString() }
}

const expectations = () => ({ payer: vaultKey.toBase58(), buyer: OWNER, buyerTokenAccount: OWNER,
  mint: MINT, listState: LISTING, seller: SELLER, priceLamports: PRICE })

test('Tensor creator royalty accounts survive validation and CPI account conversion', () => {
  const instruction = buyLegacyInstruction()
  instruction.accounts.push({ address: SELLER, isSigner: false, isWritable: true })
  assert.doesNotThrow(() => assertTensorBuyLegacyInstruction(instruction, expectations()))
  assert.equal(tensorRemainingAccounts(instruction).length, 25)
  assert.equal(tensorRemainingAccounts(instruction)[24].pubkey.toBase58(), SELLER)
  instruction.accounts[24].isSigner = true
  assert.throws(() => assertTensorBuyLegacyInstruction(instruction, expectations()))
  instruction.accounts[24].isSigner = false
  instruction.accounts[24].isWritable = false
  assert.throws(() => assertTensorBuyLegacyInstruction(instruction, expectations()))
  instruction.accounts[24].isWritable = true
  instruction.accounts.push(...Array.from({ length: 5 }, () => ({ address: SELLER, isSigner: false, isWritable: true })))
  assert.throws(() => assertTensorBuyLegacyInstruction(instruction, expectations()))
})

test('status closes a missing attempt atomically without RPC or broadcasting', async () => {
  let stored: NftPurchaseOrder | undefined
  const orders: AssetStore<NftPurchaseOrder> = {
    get: async () => stored,
    put: async (_user, _id, value, once) => { assert.equal(once, true); stored ??= value },
    list: async () => [], take: async () => undefined,
  }
  const service = new NftPurchaseService(() => { throw new Error('RPC must not run') }, undefined, undefined, orders)
  const result = await service.status('user', DISCOVERY)
  assert.equal(result.status, 'FAILED')
  assert.equal(result.signature, null)
  assert.equal(stored?.attempts, 0)
  assert.deepEqual(await service.status('user', DISCOVERY), result)
})

test('the order id is stable, 16 bytes, and derived only from the discovery', () => {
  assert.equal(orderIdFor(DISCOVERY).length, 16)
  assert.equal(orderIdHex(DISCOVERY), orderIdHex(DISCOVERY))
  assert.equal(isValidOrderIdHex(orderIdHex(DISCOVERY)), true)
  assert.throws(() => orderIdFor('not-a-uuid'))
  assert.equal(isValidOrderIdHex('0'.repeat(32)), false)
})

test('an authorization inside the ceiling is allowed and reports its exact ceiling', () => {
  const authorization: NftPurchaseAuthorizationState = { version: NFT_PURCHASE_AUTH_VERSION, active: true,
    mandate: 'm', owner: OWNER, executor: EXECUTOR, marketplace: TENSOR_MARKETPLACE_PROGRAM_ID,
    recipient: OWNER, maxTotalDebitLamports: 100_000_000n, spentLamports: 0n, expiresAt: 2_000_000_000 }
  const verdict = checkNftPurchaseAuthorization({ authorization, mandate: 'm', owner: OWNER, executor: EXECUTOR,
    marketplace: TENSOR_MARKETPLACE_PROGRAM_ID, priceLamports: PRICE, nowSeconds: 1_800_000_000 })
  assert.deepEqual(verdict, { allowed: true, remainingLamports: 100_000_000n, ceilingLamports: maxAllowedDebit(PRICE) })
})

test('every way an authorization can fail is named, never silently allowed', () => {
  const base: NftPurchaseAuthorizationState = { version: NFT_PURCHASE_AUTH_VERSION, active: true, mandate: 'm',
    owner: OWNER, executor: EXECUTOR, marketplace: TENSOR_MARKETPLACE_PROGRAM_ID, recipient: OWNER,
    maxTotalDebitLamports: 100_000_000n, spentLamports: 0n, expiresAt: 2_000_000_000 }
  const input = { mandate: 'm', owner: OWNER, executor: EXECUTOR, marketplace: TENSOR_MARKETPLACE_PROGRAM_ID,
    priceLamports: PRICE, nowSeconds: 1_800_000_000 }
  const reject = (overrides: Partial<NftPurchaseAuthorizationState>) =>
    checkNftPurchaseAuthorization({ authorization: { ...base, ...overrides }, ...input })
  assert.deepEqual(reject({ active: false }), { allowed: false, rejection: 'PurchaseAuthorizationNotActive' })
  assert.deepEqual(reject({ expiresAt: 1_700_000_000 }), { allowed: false, rejection: 'PurchaseAuthorizationExpired' })
  assert.deepEqual(reject({ version: 2 }), { allowed: false, rejection: 'PurchaseAuthorizationMismatch' })
  assert.deepEqual(reject({ executor: SELLER }), { allowed: false, rejection: 'PurchaseAuthorizationMismatch' })
  assert.deepEqual(reject({ recipient: SELLER }), { allowed: false, rejection: 'PurchaseAuthorizationMismatch' })
  assert.deepEqual(reject({ marketplace: SELLER }), { allowed: false, rejection: 'PurchaseAuthorizationMismatch' })
  assert.deepEqual(reject({ maxTotalDebitLamports: PRICE }), { allowed: false, rejection: 'PurchaseAuthorizationBudgetExceeded' })
  assert.deepEqual(reject({ spentLamports: 100_000_000n }), { allowed: false, rejection: 'PurchaseAuthorizationBudgetExceeded' })
})

test('the ceiling covers fees and account rent beyond the bare listing price', () => {
  assert.ok(maxAllowedDebit(PRICE) > PRICE)
  assert.throws(() => maxAllowedDebit(0n))
})

test('the authorization layout round-trips and reports its remaining budget and status', () => {
  const account = decodeNftPurchaseAuthorization('auth', encodeAuthorization({
    version: NFT_PURCHASE_AUTH_VERSION, active: true, mandate: mandateKey.toBase58(), owner: OWNER,
    executor: EXECUTOR, marketplace: TENSOR_MARKETPLACE_PROGRAM_ID, recipient: OWNER,
    maxTotalDebitLamports: 100n, spentLamports: 40n, expiresAt: Math.floor(Date.now() / 1000) + 600 }))
  assert.equal(account.owner, OWNER)
  assert.equal(account.executor, EXECUTOR)
  assert.equal(account.mandate, mandateKey.toBase58())
  assert.equal(account.spentLamports, 40n)
  const serialized = serializeNftPurchaseAuthorization(account)
  assert.equal(serialized.remainingLamports, '60')
  assert.equal(serialized.status, 'ACTIVE')
})

test('a tampered or truncated authorization account is refused, not half-read', () => {
  const valid = encodeAuthorization({ version: 1, active: true, mandate: mandateKey.toBase58(), owner: OWNER,
    executor: EXECUTOR, marketplace: TENSOR_MARKETPLACE_PROGRAM_ID, recipient: OWNER,
    maxTotalDebitLamports: 1n, spentLamports: 0n, expiresAt: 0 })
  const tampered = Buffer.from(valid)
  tampered.writeUInt8(0, 0)
  assert.throws(() => decodeNftPurchaseAuthorization('auth', tampered))
  assert.throws(() => decodeNftPurchaseAuthorization('auth', valid.subarray(0, 100)))
  assert.equal(NFT_PURCHASE_AUTH_DATA_SIZE, 203)
})

test('a receipt decodes, and a fabricated one is refused', () => {
  const buffer = Buffer.alloc(NFT_PURCHASE_RECEIPT_DATA_SIZE)
  Buffer.from(NFT_PURCHASE_RECEIPT_DISCRIMINATOR, 'hex').copy(buffer, 0)
  buffer.writeUInt8(1, 8)
  const keys = [mandateKey.toBase58(), nftAuthorizationAddress(PROGRAM_ID, mandateKey).toBase58(),
    OWNER, EXECUTOR, MINT, LISTING, TENSOR_MARKETPLACE_PROGRAM_ID]
  keys.forEach((key, index) => new PublicKey(key).toBuffer().copy(buffer, 9 + index * 32))
  buffer.writeBigUInt64LE(PRICE, 233)
  buffer.writeBigUInt64LE(PRICE, 241)
  orderIdFor(DISCOVERY).copy(buffer, 249)
  buffer.writeBigInt64LE(1_800_000_000n, 265)
  buffer.writeUInt8(255, 273)
  const receipt = decodeNftPurchaseReceipt('receipt', buffer)
  assert.equal(receipt.orderId, orderIdHex(DISCOVERY))
  assert.equal(receipt.mint, MINT)
  assert.equal(receipt.priceLamports, PRICE.toString())
  const fabricated = Buffer.from(buffer)
  fabricated.writeUInt8(0, 0)
  assert.throws(() => decodeNftPurchaseReceipt('receipt', fabricated))
  assert.equal(NFT_PURCHASE_RECEIPT_DATA_SIZE, 274)
})

test('the verified BuyLegacy shape is accepted and the vault loses signer privilege', () => {
  const instruction = buyLegacyInstruction()
  assert.doesNotThrow(() => assertTensorBuyLegacyInstruction(instruction, expectations()))
  const remaining = tensorRemainingAccounts(instruction)
  assert.equal(remaining.length, TENSOR_BUY_LEGACY_ACCOUNTS)
  assert.ok(remaining.every(account => account.isSigner === false))
  assert.equal(remaining[IX_PAYER].pubkey.toBase58(), vaultKey.toBase58())
  assert.equal(TENSOR_BUY_LEGACY_DATA_LENGTH, 18)
})

test('a swapped payer, changed price, short account list or extra payload is refused before signing', () => {
  assert.throws(() => assertTensorBuyLegacyInstruction(buyLegacyInstruction({ payer: OWNER }), expectations()))
  assert.throws(() => assertTensorBuyLegacyInstruction(buyLegacyInstruction({ price: PRICE + 1n }), expectations()))
  assert.throws(() => assertTensorBuyLegacyInstruction(buyLegacyInstruction({ accounts: 23 }), expectations()))
  const price = Buffer.alloc(8)
  price.writeBigUInt64LE(PRICE)
  const withPayload = Buffer.concat([Buffer.from(TENSOR_BUY_LEGACY_DISCRIMINATOR, 'hex'), price, Buffer.from([0, 1])])
  assert.throws(() => assertTensorBuyLegacyInstruction(buyLegacyInstruction({ data: withPayload }), expectations()))
})

test('the approval instruction matches the Anchor account order exactly', () => {
  const instruction = createNftPurchaseAuthorizationInstruction(PROGRAM_ID, new PublicKey(OWNER),
    { maxTotalDebitLamports: 100n, expiresAt: 2_000_000_000, executor: new PublicKey(EXECUTOR), recipient: new PublicKey(OWNER) })
  assert.ok(instruction.data.subarray(0, 8).equals(NFT_PURCHASE_INSTRUCTIONS.createNftPurchaseAuthorization))
  assert.deepEqual(instruction.keys.map(key => key.pubkey.toBase58()),
    [OWNER, mandateKey.toBase58(), nftAuthorizationAddress(PROGRAM_ID, mandateKey).toBase58(),
      '11111111111111111111111111111111'])
  assert.equal(instruction.keys[0].isSigner, true)
  assert.equal(instruction.data.length, 8 + 8 + 8 + 96)
  assert.equal(NFT_AUTH_SEED, 'nft-auth')
})

test('the purchase instruction puts the vault in the payer slot the program signs with invoke_signed', () => {
  const orderId = orderIdFor(DISCOVERY)
  const instruction = buyNftFromMandateInstruction(PROGRAM_ID, { executor: new PublicKey(EXECUTOR), owner: OWNER,
    orderId, expectedMint: new PublicKey(MINT), maxPriceLamports: PRICE,
    tensorAccounts: tensorRemainingAccounts(buyLegacyInstruction()) })
  assert.equal(instruction.keys[0].pubkey.toBase58(), EXECUTOR)
  assert.equal(instruction.keys[2].pubkey.toBase58(), nftAuthorizationAddress(PROGRAM_ID, mandateKey).toBase58())
  assert.equal(instruction.keys[3].pubkey.toBase58(), vaultKey.toBase58())
  assert.equal(instruction.keys[4].pubkey.toBase58(), purchaseReceiptAddress(PROGRAM_ID, mandateKey, orderId).toBase58())
  assert.equal(instruction.keys.length, 6 + TENSOR_BUY_LEGACY_ACCOUNTS)
  // Only the executor signs the outer transaction; the vault is signed inside the program.
  assert.ok(instruction.keys.every(key => key.isSigner === (key.pubkey.toBase58() === EXECUTOR)))
  assert.equal(instruction.data.length, 8 + 16 + 32 + 8)
  assert.equal(PURCHASE_SEED, 'purchase')
})

test('live purchase execution is off unless explicitly enabled', () => {
  assert.equal(nftPurchaseLiveEnabled({}), false)
  assert.equal(nftPurchaseLiveEnabled({ NFT_PURCHASE_LIVE_ENABLED: 'false' }), false)
  assert.equal(nftPurchaseLiveEnabled({ NFT_PURCHASE_LIVE_ENABLED: ' TRUE ' }), true)
})

test('a new order can never fall back to the DEMO autonomous flow', () => {
  assert.equal(demoAutoPurchaseEnabled({}), false)
  assert.equal(demoAutoPurchaseEnabled({ GOBUY_DEMO_AUTOPURCHASE_ENABLED: 'false' }), false)
  assert.equal(demoAutoPurchaseEnabled({ GOBUY_DEMO_AUTOPURCHASE_ENABLED: 'true' }), true)
  assert.equal(NFT_PURCHASE_DELIVERY_MODE, 'ORIGINAL_NFT_TRANSFER')
})
