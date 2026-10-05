import { createHash } from 'node:crypto'
import { PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js'
import { MANDATE_CATEGORY_CODE, type MandateCategory } from '@gobuy/shared'
import { mandateAddress, mandateVaultAddress } from './MandateGuard.js'

/**
 * Hand-rolled Anchor instruction encoding for the Na Vault program.
 *
 * The backend deliberately does not pull in an Anchor client: the program surface is four
 * instructions with trivial arguments, and encoding them here keeps the dependency list unchanged.
 * Every byte layout below is mirrored from `anchor/programs/gobuy_na/src/lib.rs`.
 */

/** Anchor instruction discriminators: the first 8 bytes of sha256("global:<name>"). */
export function instructionDiscriminator(name: string): Buffer {
  return createHash('sha256').update('global:' + name).digest().subarray(0, 8)
}

export const NA_INSTRUCTIONS = Object.freeze({
  createMandate: instructionDiscriminator('create_mandate'),
  spendFromMandate: instructionDiscriminator('spend_from_mandate'),
  cancelMandate: instructionDiscriminator('cancel_mandate'),
  withdrawRemaining: instructionDiscriminator('withdraw_remaining'),
})

export function u64Le(value: bigint): Buffer {
  if (value < 0n || value > 0xffffffffffffffffn) throw new Error('Value is outside the u64 range.')
  const buffer = Buffer.alloc(8)
  buffer.writeBigUInt64LE(value)
  return buffer
}

export function i64Le(value: bigint): Buffer {
  if (value < -9223372036854775808n || value > 9223372036854775807n) throw new Error('Value is outside the i64 range.')
  const buffer = Buffer.alloc(8)
  buffer.writeBigInt64LE(value)
  return buffer
}

export function hexBytes(value: string, expectedBytes: number, label: string): Buffer {
  if (!new RegExp('^[0-9a-f]{' + expectedBytes * 2 + '}$').test(value)) {
    throw new Error(label + ' must be ' + expectedBytes + ' bytes of lowercase hex.')
  }
  return Buffer.from(value, 'hex')
}

/** Anchor arguments: `max_budget_lamports: u64, expires_at: i64, allowed_category: u8, recipient: Pubkey`. */
export function encodeCreateMandateArgs(input: { maxBudgetLamports: bigint; expiresAt: number; category: MandateCategory; recipient: PublicKey; executor: PublicKey }): Buffer {
  return Buffer.concat([
    u64Le(input.maxBudgetLamports),
    i64Le(BigInt(input.expiresAt)),
    Buffer.from([MANDATE_CATEGORY_CODE[input.category]]),
    input.recipient.toBuffer(),
    input.executor.toBuffer(),
  ])
}

/** Anchor arguments: `amount_lamports: u64, category: u8, spend_id: [u8; 16], asset_hash: [u8; 32]`. */
export function encodeSpendArgs(input: { amountLamports: bigint; category: MandateCategory; spendId: string; assetHash: string }): Buffer {
  return Buffer.concat([
    u64Le(input.amountLamports),
    Buffer.from([MANDATE_CATEGORY_CODE[input.category]]),
    hexBytes(input.spendId, 16, 'spendId'),
    hexBytes(input.assetHash, 32, 'assetHash'),
  ])
}

export function mandatePdas(programId: PublicKey, owner: PublicKey) {
  const mandate = mandateAddress(programId, owner.toBase58())
  return { mandate, vault: mandateVaultAddress(programId, mandate) }
}

export function spendRecordAddress(programId: PublicKey, mandate: PublicKey, spendId: Buffer): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from('spend'), mandate.toBuffer(), spendId], programId)[0]
}

/** `create_mandate`: the one Phantom-signed step. It funds the vault with the authorized budget. */
export function createMandateInstruction(programId: PublicKey, owner: PublicKey, args: {
  maxBudgetLamports: bigint; expiresAt: number; category: MandateCategory; recipient: PublicKey; executor: PublicKey
}): TransactionInstruction {
  const { mandate, vault } = mandatePdas(programId, owner)
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: owner, isSigner: true, isWritable: true },
      { pubkey: mandate, isSigner: false, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([NA_INSTRUCTIONS.createMandate, encodeCreateMandateArgs(args)]),
  })
}

/**
 * `spend_from_mandate`: the autonomous step. The vault PDA signs the transfer, so the owner's key
 * is never involved. `payer` is the executor the owner authorized and also pays fees and receipt rent.
 */
export function spendFromMandateInstruction(programId: PublicKey, payer: PublicKey, input: {
  mandate: PublicKey; vault: PublicKey; recipient: PublicKey
  amountLamports: bigint; category: MandateCategory; spendId: string; assetHash: string
}): TransactionInstruction {
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: input.mandate, isSigner: false, isWritable: true },
      { pubkey: input.vault, isSigner: false, isWritable: true },
      { pubkey: input.recipient, isSigner: false, isWritable: true },
      { pubkey: spendRecordAddress(programId, input.mandate, hexBytes(input.spendId, 16, 'spendId')), isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([NA_INSTRUCTIONS.spendFromMandate, encodeSpendArgs(input)]),
  })
}

/** Owner-only instructions. No arguments; the program re-derives the vault from the mandate. */
export function cancelMandateInstruction(programId: PublicKey, owner: PublicKey): TransactionInstruction {
  const { mandate, vault } = mandatePdas(programId, owner)
  return ownerInstruction(programId, NA_INSTRUCTIONS.cancelMandate, owner, mandate, vault)
}

export function withdrawRemainingInstruction(programId: PublicKey, owner: PublicKey): TransactionInstruction {
  const { mandate, vault } = mandatePdas(programId, owner)
  return ownerInstruction(programId, NA_INSTRUCTIONS.withdrawRemaining, owner, mandate, vault)
}

function ownerInstruction(programId: PublicKey, discriminator: Buffer, owner: PublicKey, mandate: PublicKey, vault: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: owner, isSigner: true, isWritable: true },
      { pubkey: mandate, isSigner: false, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: discriminator,
  })
}
