import { PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js'
import { NFT_AUTH_SEED, PURCHASE_SEED, TENSOR_MARKETPLACE_PROGRAM_ID } from '@gobuy/shared'
import { hexBytes, instructionDiscriminator, i64Le, u64Le } from '../mandate/mandateInstructions.js'
import { mandateAddress, mandateVaultAddress } from '../mandate/MandateGuard.js'

/**
 * Hand-rolled Anchor encoding for the genuine-purchase instructions of the Na Vault program.
 *
 * The backend deliberately does not pull in an Anchor client: every byte layout below mirrors
 * `anchor/programs/gobuy_na/src/nft_purchase.rs`. Account order is the struct declaration order.
 */

export const NFT_PURCHASE_INSTRUCTIONS = Object.freeze({
  createNftPurchaseAuthorization: instructionDiscriminator('create_nft_purchase_authorization'),
  closeNftPurchaseAuthorization: instructionDiscriminator('close_nft_purchase_authorization'),
  buyNftFromMandate: instructionDiscriminator('buy_nft_from_mandate'),
})

/** `["nft-auth", mandate]` - the versioned purchase authorization PDA. */
export function nftAuthorizationAddress(programId: PublicKey, mandate: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from(NFT_AUTH_SEED), mandate.toBuffer()], programId)[0]
}

/** `["purchase", mandate, order_id]` - one immutable receipt per order. */
export function purchaseReceiptAddress(programId: PublicKey, mandate: PublicKey, orderId: Buffer): PublicKey {
  if (orderId.length !== 16) throw new Error('orderId must be 16 bytes.')
  return PublicKey.findProgramAddressSync([Buffer.from(PURCHASE_SEED), mandate.toBuffer(), orderId], programId)[0]
}

/** `marketplace: Pubkey, executor: Pubkey, recipient: Pubkey` after the two numeric arguments. */
export function encodeCreateNftPurchaseAuthorizationArgs(input: {
  maxTotalDebitLamports: bigint; expiresAt: number; marketplace: PublicKey; executor: PublicKey; recipient: PublicKey
}): Buffer {
  return Buffer.concat([
    u64Le(input.maxTotalDebitLamports),
    i64Le(BigInt(input.expiresAt)),
    input.marketplace.toBuffer(),
    input.executor.toBuffer(),
    input.recipient.toBuffer(),
  ])
}

/** `order_id: [u8; 16], expected_mint: Pubkey, max_price_lamports: u64`. */
export function encodeBuyNftArgs(input: { orderId: Buffer; expectedMint: PublicKey; maxPriceLamports: bigint }): Buffer {
  if (input.orderId.length !== 16) throw new Error('orderId must be 16 bytes.')
  return Buffer.concat([input.orderId, input.expectedMint.toBuffer(), u64Le(input.maxPriceLamports)])
}

/** The owner-signed approval of the purchase policy. This is the explicit user authorization. */
export function createNftPurchaseAuthorizationInstruction(programId: PublicKey, owner: PublicKey, input: {
  maxTotalDebitLamports: bigint; expiresAt: number; executor: PublicKey; recipient: PublicKey
}): TransactionInstruction {
  const mandate = mandateAddress(programId, owner.toBase58())
  const nftAuthorization = nftAuthorizationAddress(programId, mandate)
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: owner, isSigner: true, isWritable: true },
      { pubkey: mandate, isSigner: false, isWritable: false },
      { pubkey: nftAuthorization, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([NFT_PURCHASE_INSTRUCTIONS.createNftPurchaseAuthorization,
      encodeCreateNftPurchaseAuthorizationArgs({ ...input, marketplace: new PublicKey(TENSOR_MARKETPLACE_PROGRAM_ID) })]),
  })
}

/** Owner-only revocation. Closing the account removes the only path to a purchase. */
export function closeNftPurchaseAuthorizationInstruction(programId: PublicKey, owner: PublicKey): TransactionInstruction {
  const mandate = mandateAddress(programId, owner.toBase58())
  const nftAuthorization = nftAuthorizationAddress(programId, mandate)
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: owner, isSigner: true, isWritable: true },
      { pubkey: mandate, isSigner: false, isWritable: false },
      { pubkey: nftAuthorization, isSigner: false, isWritable: true },
    ],
    data: NFT_PURCHASE_INSTRUCTIONS.closeNftPurchaseAuthorization,
  })
}

/**
 * The genuine purchase instruction. `executor` signs and pays fees/rent; the Tensor BuyLegacy
 * accounts follow as `remaining_accounts` in the verified order, with the vault PDA as `payer`.
 */
export function buyNftFromMandateInstruction(programId: PublicKey, input: {
  executor: PublicKey
  owner: string
  orderId: Buffer
  expectedMint: PublicKey
  maxPriceLamports: bigint
  tensorAccounts: ReadonlyArray<{ pubkey: PublicKey; isSigner: boolean; isWritable: boolean }>
}): TransactionInstruction {
  const mandate = mandateAddress(programId, input.owner)
  const vault = mandateVaultAddress(programId, mandate)
  const nftAuthorization = nftAuthorizationAddress(programId, mandate)
  const receipt = purchaseReceiptAddress(programId, mandate, input.orderId)
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: input.executor, isSigner: true, isWritable: true },
      { pubkey: mandate, isSigner: false, isWritable: true },
      { pubkey: nftAuthorization, isSigner: false, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: receipt, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ...input.tensorAccounts.map(account => ({ pubkey: account.pubkey, isSigner: false, isWritable: account.isWritable })),
    ],
    data: Buffer.concat([NFT_PURCHASE_INSTRUCTIONS.buyNftFromMandate,
      encodeBuyNftArgs({ orderId: input.orderId, expectedMint: input.expectedMint, maxPriceLamports: input.maxPriceLamports })]),
  })
}

/** Re-exported so the purchase service can decode an order id without another import. */
export { hexBytes }
