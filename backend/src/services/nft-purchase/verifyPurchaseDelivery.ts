import { PublicKey, type ParsedTransactionWithMeta } from '@solana/web3.js'
import { getAssociatedTokenAddressSync } from '@solana/spl-token'
import { base58Decode, TENSOR_MARKETPLACE_PROGRAM_ID, type NftPurchaseReceipt, type NftPurchaseResult } from '@gobuy/shared'

/** Receipt plus finalized execution evidence, not an HTTP success or a current balance alone. */
export function verifyPurchaseDelivery(tx: ParsedTransactionWithMeta, signature: string, program: PublicKey,
  receipt: NftPurchaseReceipt): NonNullable<NftPurchaseResult['delivery']> {
  if (!tx.meta || tx.meta.err || tx.transaction.signatures[0] !== signature) throw new Error('Purchase transaction is not successful.')
  const keys = tx.transaction.message.accountKeys
  const purchases = tx.transaction.message.instructions.filter(ix => ix.programId.equals(program))
  const purchase = purchases[0]
  if (purchases.length !== 1 || !purchase || !('data' in purchase)) throw new Error('Purchase instruction missing.')
  const data = Buffer.from(base58Decode(purchase.data))
  if (data.length !== 64 || data.subarray(0,8).toString('hex') !== 'e5306fdbb58a7b03'
    || data.subarray(8,24).toString('hex') !== receipt.orderId
    || new PublicKey(data.subarray(24,56)).toBase58() !== receipt.mint
    || data.readBigUInt64LE(56) !== BigInt(receipt.priceLamports)
    || purchase.accounts[4]?.toBase58() !== receipt.address) throw new Error('Purchase instruction differs from receipt.')
  const receiptIndex = keys.findIndex(key => key.pubkey.toBase58() === receipt.address)
  if (receiptIndex < 0 || tx.meta.preBalances[receiptIndex] !== 0 || tx.meta.postBalances[receiptIndex] <= 0) {
    throw new Error('Receipt was not created by this transaction.')
  }
  if (keys.filter(key => key.signer).length !== 1 || keys[0]?.pubkey.toBase58() !== receipt.executor
    || !keys.some(key => key.pubkey.toBase58() === receipt.address)
    || !tx.transaction.message.instructions.some(ix => ix.programId.equals(program))
    || !tx.meta.logMessages?.includes(`Program ${program.toBase58()} invoke [1]`)
    || !tx.meta.logMessages?.includes(`Program ${TENSOR_MARKETPLACE_PROGRAM_ID} invoke [2]`)) {
    throw new Error('Purchase transaction does not match the receipt/executor/CPI.')
  }
  const ata = getAssociatedTokenAddressSync(new PublicKey(receipt.mint), new PublicKey(receipt.owner)).toBase58()
  const index = keys.findIndex(key => key.pubkey.toBase58() === ata)
  const after = tx.meta.postTokenBalances?.find(balance => balance.accountIndex === index)
  const before = tx.meta.preTokenBalances?.find(balance => balance.accountIndex === index)
  if (index < 0 || !after || after.mint !== receipt.mint || after.owner !== receipt.owner
    || after.uiTokenAmount.amount !== '1' || after.uiTokenAmount.decimals !== 0
    || (before && before.uiTokenAmount.amount !== '0')) throw new Error('Original NFT delivery is not verified.')
  return { owner: receipt.owner, mint: receipt.mint, tokenAccount: ata, signature, slot: tx.slot, commitment: 'finalized', amount: '1' }
}
