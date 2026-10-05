import { ComputeBudgetProgram, PublicKey, Transaction, type TransactionInstruction } from '@solana/web3.js'
import { CREATE_MANDATE_COMPUTE_UNIT_LIMIT, CREATE_MANDATE_COMPUTE_UNIT_PRICE_MICRO_LAMPORTS, type MandateCategory } from '@gobuy/shared'
import { InputError } from '../../schemas/search.js'
import { cancelMandateInstruction, createMandateInstruction, mandatePdas, withdrawRemainingInstruction } from './mandateInstructions.js'

/**
 * The owner-signed half of the mandate lifecycle: authorize/fund, revoke, reclaim.
 *
 * These are the only transactions that require Phantom. Na never signs them, and `submit` refuses
 * anything that is not byte-for-byte the action the user asked for, so a tampered client cannot
 * turn a "revoke" request into a different on-chain instruction.
 */

export type OwnerAction = 'create' | 'revoke' | 'withdraw'

/** Exact prefix the client must add before review/signing; never accept wallet-selected values. */
export function createMandateComputeBudgetInstructions(): TransactionInstruction[] {
  return [
    ComputeBudgetProgram.setComputeUnitLimit({ units: CREATE_MANDATE_COMPUTE_UNIT_LIMIT }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: CREATE_MANDATE_COMPUTE_UNIT_PRICE_MICRO_LAMPORTS }),
  ]
}

export type CreateMandateParams = {
  maxBudgetLamports: bigint
  expiresAt: number
  category: MandateCategory
  executor: PublicKey
  recipient: PublicKey
}

export function ownerInstruction(programId: PublicKey, action: OwnerAction, owner: PublicKey, create?: CreateMandateParams): TransactionInstruction {
  switch (action) {
    case 'create':
      if (!create) throw new InputError('Thiếu tham số tạo mandate.')
      return createMandateInstruction(programId, owner, create)
    case 'revoke':
      return cancelMandateInstruction(programId, owner)
    case 'withdraw':
      return withdrawRemainingInstruction(programId, owner)
  }
}

export function buildOwnerTransaction(programId: PublicKey, action: OwnerAction, owner: PublicKey,
  blockhash: string, lastValidBlockHeight: number, create?: CreateMandateParams): Transaction {
  return new Transaction({ feePayer: owner, blockhash, lastValidBlockHeight })
    .add(ownerInstruction(programId, action, owner, create))
}

/**
 * Zero-account ComputeBudget configuration (compute unit limit / priority fee). Wallets, Phantom
 * included, inject these while signing; because they carry no account metas they cannot move SOL,
 * add a signer or touch the mandate vault, so they are the only instruction a wallet may add.
 */
export function isWalletComputeBudgetInstruction(instruction: TransactionInstruction): boolean {
  return instruction.programId.equals(ComputeBudgetProgram.programId) && instruction.keys.length === 0
}

function sameInstruction(a: TransactionInstruction, b: TransactionInstruction): boolean {
  return a.programId.equals(b.programId) && Buffer.from(a.data).equals(Buffer.from(b.data)) &&
    a.keys.length === b.keys.length &&
    a.keys.every((key, index) => key.pubkey.equals(b.keys[index].pubkey) &&
      key.isSigner === b.keys[index].isSigner && key.isWritable === b.keys[index].isWritable)
}

/**
 * True when the submitted transaction carries exactly the instructions the server built, in order,
 * ignoring ONLY zero-account ComputeBudget instructions the wallet added. Anything removed,
 * reordered or altered fails, and so does any added instruction that references accounts.
 */
export function ownerInstructionsMatch(expected: TransactionInstruction[], submitted: TransactionInstruction[]): boolean {
  const remaining = [...expected]
  const kept: TransactionInstruction[] = []
  for (const instruction of submitted) {
    const index = remaining.findIndex(candidate => sameInstruction(candidate, instruction))
    if (index >= 0) { remaining.splice(index, 1); kept.push(instruction) }
    else if (!isWalletComputeBudgetInstruction(instruction)) kept.push(instruction)
  }
  return remaining.length === 0 && kept.length === expected.length &&
    kept.every((instruction, index) => sameInstruction(instruction, expected[index]))
}

/**
 * The client must sign exactly the instructions the server built. `ownerInstructionsMatch` proves
 * that no instruction was added (apart from wallet ComputeBudget configuration), removed or altered
 * before sending, and the fee payer and signature are checked separately.
 */
export function assertExpectedOwnerTransaction(submitted: Transaction, expected: TransactionInstruction | TransactionInstruction[], owner: PublicKey): void {
  if (!submitted.recentBlockhash) throw new InputError('Giao dịch thiếu blockhash. Yêu cầu lại giao dịch mandate và ký lại.')
  if (!submitted.feePayer || !submitted.feePayer.equals(owner)) {
    throw new InputError('Ví trả phí của giao dịch không khớp ví đang kết nối. Na không gửi giao dịch.')
  }
  if (!submitted.verifySignatures()) {
    throw new InputError('Chữ ký ví không hợp lệ với nội dung giao dịch. Na không gửi giao dịch.')
  }
  if (!ownerInstructionsMatch(Array.isArray(expected) ? expected : [expected], submitted.instructions)) {
    throw new InputError('Nội dung giao dịch không khớp thao tác mandate đã yêu cầu. Na từ chối gửi.')
  }
}

/** Addresses the UI shows while the user reviews the Phantom prompt. */
export function ownerTransactionAddresses(programId: PublicKey, owner: PublicKey) {
  const { mandate, vault } = mandatePdas(programId, owner)
  return { mandate: mandate.toBase58(), vault: vault.toBase58() }
}
