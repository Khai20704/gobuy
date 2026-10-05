import { ComputeBudgetProgram, type Transaction } from '@solana/web3.js'
import { CREATE_MANDATE_COMPUTE_UNIT_LIMIT, CREATE_MANDATE_COMPUTE_UNIT_PRICE_MICRO_LAMPORTS } from '@gobuy/shared'

/** Only called for the backend's unsigned, single-instruction CreateMandate response. */
export function prependCreateMandateComputeBudget(transaction: Transaction): void {
  if (transaction.instructions.length !== 1 || transaction.instructions[0].programId.equals(ComputeBudgetProgram.programId)
    || transaction.signatures.some(slot => slot.signature !== null)) {
    throw new Error('Expected one unsigned CreateMandate instruction before configuring compute budget.')
  }
  transaction.instructions.unshift(
    ComputeBudgetProgram.setComputeUnitLimit({ units: CREATE_MANDATE_COMPUTE_UNIT_LIMIT }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: CREATE_MANDATE_COMPUTE_UNIT_PRICE_MICRO_LAMPORTS }),
  )
}
