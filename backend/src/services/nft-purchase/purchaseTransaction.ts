import { ComputeBudgetProgram, Transaction, type TransactionInstruction, type PublicKey, type BlockhashWithExpiryBlockHeight } from '@solana/web3.js'

// Archived real CPI consumed 111,992 CU (largest negative 114,954). 200k leaves ~74% headroom.
// Unsupported/heavier listings fail closed in preflight; never auto-increase and resubmit.
export const NFT_PURCHASE_COMPUTE_UNITS = 200_000
export const SOLANA_PACKET_BYTES = 1232
export function purchaseTransaction(payer: PublicKey, blockhash: BlockhashWithExpiryBlockHeight, instruction: TransactionInstruction) {
  const transaction = new Transaction({ feePayer: payer, ...blockhash })
    .add(ComputeBudgetProgram.setComputeUnitLimit({ units: NFT_PURCHASE_COMPUTE_UNITS }), instruction)
  assertPurchasePacketSize(transaction)
  return transaction
}
export function assertPurchasePacketSize(transaction: Transaction): number {
  const size = transaction.serialize({ requireAllSignatures: false, verifySignatures: false }).length
  if (size > SOLANA_PACKET_BYTES) throw new Error('NFT purchase exceeds the Solana transaction packet limit.')
  return size
}
