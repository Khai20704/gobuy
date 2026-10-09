import { PublicKey } from '@solana/web3.js'
import { NFTPurchaseError } from '../../nft/errors.js'
import { TENSOR_MARKETPLACE_PROGRAM_ID, TENSOR_BUY_LEGACY_ACCOUNTS, TENSOR_BUY_LEGACY_DATA_LENGTH,
  TENSOR_BUY_LEGACY_DISCRIMINATOR } from '@gobuy/shared'
import type { TensorBuyInstruction } from '@gobuy/tensor-adapter'

/**
 * The verified Tensor BuyLegacy account layout.
 *
 * Decoded from the installed, official SDK `@tensor-foundation/marketplace@1.0.0`: a live dump of
 * `getBuyLegacyInstruction` shows exactly 24 accounts in this order, with the marketplace program
 * id itself used as the sentinel for every absent optional account. Only index 7 (`payer`) is a
 * signer, and only index 1 (`buyer`) receives the NFT (through index 2, its associated account).
 *
 * The Anchor program re-derives all of this on chain; this table is the client's proof that the
 * account list it hands over is the list that was laid out here.
 */
export const TENSOR_BUY_LEGACY_LAYOUT: ReadonlyArray<{ name: string; writable: boolean }> = Object.freeze([
  { name: 'feeVault', writable: true },
  { name: 'buyer', writable: false },
  { name: 'buyerTa', writable: true },
  { name: 'listTa', writable: true },
  { name: 'listState', writable: true },
  { name: 'mint', writable: false },
  { name: 'owner', writable: true },
  { name: 'payer', writable: true },
  { name: 'takerBroker', writable: false },
  { name: 'makerBroker', writable: false },
  { name: 'rentDestination', writable: true },
  { name: 'tokenProgram', writable: false },
  { name: 'associatedTokenProgram', writable: false },
  { name: 'marketplaceProgram', writable: false },
  { name: 'systemProgram', writable: false },
  { name: 'metadata', writable: true },
  { name: 'edition', writable: false },
  { name: 'buyerTokenRecord', writable: false },
  { name: 'listTokenRecord', writable: false },
  { name: 'authorizationRules', writable: false },
  { name: 'authorizationRulesProgram', writable: false },
  { name: 'tokenMetadataProgram', writable: false },
  { name: 'sysvarInstructions', writable: false },
  { name: 'cosigner', writable: false },
])

export const IX_BUYER = 1
export const IX_BUYER_TA = 2
export const IX_LIST_STATE = 4
export const IX_MINT = 5
export const IX_SELLER = 6
export const IX_PAYER = 7
export const IX_MARKETPLACE_PROGRAM = 13

/** What one order must resolve to before the vault is allowed to pay for it. */
export type TensorBuyExpectations = {
  /** The vault PDA: BuyLegacy `payer`, signed on chain with the vault seeds. */
  payer: string
  /** The mandate owner: BuyLegacy `buyer`, and therefore the NFT recipient. */
  buyer: string
  buyerTokenAccount: string
  mint: string
  listState: string
  seller: string
  priceLamports: bigint
}

function reject(reason: string): never {
  throw new NFTPurchaseError(reason as never)
}

/**
 * Fails closed unless the SDK returned exactly the verified BuyLegacy shape for this order.
 * Any drift in the SDK, a different program, a swapped payer/buyer or a changed price is refused
 * before a transaction is built.
 */
export function assertTensorBuyLegacyInstruction(instruction: TensorBuyInstruction,
  expected: TensorBuyExpectations): void {
  if (instruction.programAddress !== TENSOR_MARKETPLACE_PROGRAM_ID) reject('NETWORK_MISMATCH')
  if (instruction.accounts.length !== TENSOR_BUY_LEGACY_ACCOUNTS) reject('LISTING_UNAVAILABLE')
  const hex = Buffer.from(instruction.data.subarray(0, 8)).toString('hex')
  if (hex !== TENSOR_BUY_LEGACY_DISCRIMINATOR) reject('LISTING_UNAVAILABLE')
  if (instruction.data.length !== TENSOR_BUY_LEGACY_DATA_LENGTH) reject('LISTING_UNAVAILABLE')
  // The two optional trailing fields must both be None: this path supports no royalty override and
  // no cosigner authorization data, so no arbitrary payload can be smuggled through the CPI.
  if (instruction.data[16] !== 0 || instruction.data[17] !== 0) reject('SIGNING_UNAVAILABLE')
  const at = (index: number) => instruction.accounts[index].address
  if (at(IX_MARKETPLACE_PROGRAM) !== TENSOR_MARKETPLACE_PROGRAM_ID) reject('NETWORK_MISMATCH')
  if (at(IX_PAYER) !== expected.payer) reject('POLICY_REJECTED')
  if (at(IX_BUYER) !== expected.buyer) reject('POLICY_REJECTED')
  if (at(IX_BUYER_TA) !== expected.buyerTokenAccount) reject('POLICY_REJECTED')
  if (at(IX_MINT) !== expected.mint) reject('LISTING_CHANGED')
  if (at(IX_LIST_STATE) !== expected.listState) reject('LISTING_CHANGED')
  if (at(IX_SELLER) !== expected.seller) reject('LISTING_CHANGED')
  const price = Buffer.from(instruction.data.subarray(8, 16)).readBigUInt64LE(0)
  if (price !== expected.priceLamports) reject('PRICE_CHANGED')
}

/**
 * The Tensor accounts as `remaining_accounts` for the GoBuy purchase instruction. Every account is
 * passed as a non-signer: the vault is a PDA, and the program re-marks `payer` as a signer inside
 * `invoke_signed` using the vault seeds.
 */
export function tensorRemainingAccounts(instruction: TensorBuyInstruction) {
  if (instruction.accounts.length !== TENSOR_BUY_LEGACY_ACCOUNTS) reject('LISTING_UNAVAILABLE')
  return instruction.accounts.map(account => ({
    pubkey: new PublicKey(account.address),
    isSigner: false,
    // Writability comes from the SDK's own resolved roles, not a fixed table: an absent optional
    // account is the marketplace program id (read-only), while a real maker/taker broker or rent
    // destination is writable. Taking the SDK's value means the CPI never requests more privilege
    // than the outer transaction granted.
    isWritable: account.isWritable,
  }))
}
