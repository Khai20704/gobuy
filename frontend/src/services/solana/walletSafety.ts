import { VersionedTransaction, type Transaction } from '@solana/web3.js'
import { CREATE_MANDATE_COMPUTE_UNIT_LIMIT, CREATE_MANDATE_COMPUTE_UNIT_PRICE_MICRO_LAMPORTS } from '@gobuy/shared'
import type { PhantomProvider } from './phantom'
import { devnetConnection, requireDevnet } from './network'
import { allPostSignChecksPass, failedPostSignChecks, postSignReport, snapshotTransaction } from './postSignChecks'
import { describeMessageDiff, type MessageSnapshot } from './messageSnapshot'

export const PHANTOM_DEVNET_WARNING = 'GoBuy is currently running in Devnet testing mode. Please enable Testnet Mode / Devnet in Phantom before continuing.'
export class ExpiredDevnetTransactionError extends Error {}
export async function signDevnetTransaction(wallet: PhantomProvider, transaction: Transaction, connection = devnetConnection(), diagnostics?: { trace: string; cleanUnsigned: boolean }, simulateCreateMandate = false) {
  await requireDevnet(connection)
  if (!transaction.recentBlockhash || !(await connection.isBlockhashValid(transaction.recentBlockhash, { commitment: 'confirmed' })).value) {
    throw new ExpiredDevnetTransactionError('Transaction is not valid on Devnet or has expired. ' + PHANTOM_DEVNET_WARNING)
  }
  const owner = wallet.publicKey?.toBase58()
  if (!owner || transaction.feePayer?.toBase58() !== owner) throw new Error('Wallet does not match transaction payer.')
  const compiled = transaction.compileMessage()
  if (!compiled.accountKeys.slice(0, compiled.header.numRequiredSignatures).some(key => key.toBase58() === owner)) {
    throw new Error('Connected Phantom wallet is not a required transaction signer.')
  }
  // Detached snapshot of the unsigned MESSAGE. Signature slots and the serialized wire bytes are
  // deliberately excluded: Phantom is expected to add the user's signature, so only the message
  // (payer, blockhash, required signers and every instruction) must stay byte-identical.
  const snapshot = snapshotTransaction(transaction)
  // Logged before the wallet is called, from immutable primitives only, so a later in-place
  // mutation of the transaction cannot rewrite this record.
  console.log('[NaVault pre-sign snapshot]\n' + JSON.stringify(snapshot, null, 2))
  if (simulateCreateMandate) {
    console.log('[NaVault final transaction]\n' + JSON.stringify({
      computeUnitLimit: CREATE_MANDATE_COMPUTE_UNIT_LIMIT,
      computeUnitPriceMicroLamports: CREATE_MANDATE_COMPUTE_UNIT_PRICE_MICRO_LAMPORTS,
      instructionCount: snapshot.instructionCount, instructions: snapshot.instructions,
    }, null, 2))
    transaction.serializeMessage()
    // The versioned overload preserves the legacy message and its exact blockhash.
    const copy = VersionedTransaction.deserialize(transaction.serialize({ requireAllSignatures: false, verifySignatures: false }))
    const simulation = await connection.simulateTransaction(copy, {
      commitment: 'confirmed', sigVerify: false, replaceRecentBlockhash: false,
    })
    console.log('[NaVault final simulation]', simulation.value)
    if (simulation.value.err) throw new Error('CreateMandate simulation failed. Transaction not submitted.')
    if (!(await connection.isBlockhashValid(transaction.recentBlockhash!, { commitment: 'confirmed' })).value) {
      throw new ExpiredDevnetTransactionError('CreateMandate expired during simulation.')
    }
    if (wallet.publicKey?.toBase58() !== owner || snapshotTransaction(transaction).messageHex !== snapshot.messageHex) {
      throw new Error('Wallet or transaction changed during simulation. Signing blocked.')
    }
  }
  if (diagnostics?.cleanUnsigned) {
    if (transaction.signatures.some(slot => slot.signature !== null)) throw new Error('Clean signing experiment expected no existing signatures.')
    // Simulation and serializeMessage can repopulate null slots. Clear only in this diagnostic flow.
    transaction.signatures = []
    console.log(`[NaVault debug ${diagnostics.trace}] exact Phantom argument`, transaction)
    console.log(`[NaVault debug ${diagnostics.trace}] Phantom call snapshot\n` + JSON.stringify({
      transactionType: transaction.constructor.name,
      signatures: transaction.signatures,
      connectedPublicKey: owner,
      providerSource: typeof window !== 'undefined' && wallet === window.phantom?.solana ? 'window.phantom.solana'
        : typeof window !== 'undefined' && wallet === window.solana ? 'window.solana' : 'other',
      isPhantom: wallet.isPhantom,
      signTransactionType: typeof wallet.signTransaction,
      messageHex: snapshot.messageHex,
    }, null, 2))
  }
  let signed: Transaction
  try { signed = await wallet.signTransaction(transaction) }
  catch (cause) {
    const code = cause && typeof cause === 'object' && 'code' in cause ? cause.code : undefined
    if (code === -32603) throw cause
    if (code === 4001 || cause instanceof Error && /user rejected/i.test(cause.message)) throw cause
    const detail = typeof code === 'number' ? ` (mã ${code})` : ''
    const reason = code === -32002 ? 'Phantom đang có một cửa sổ xác nhận khác. Hãy xử lý yêu cầu đang chờ trước.'
      : code === 4900 ? 'Phantom không kết nối được mạng. Kiểm tra kết nối của ví.'
      : code === 4100 ? 'Phantom chưa cho phép tài khoản này ký. Kết nối lại đúng ví Solana.'
      : code === -32003 ? 'Phantom từ chối giao dịch vì không nhận diện được giao dịch hợp lệ. Kiểm tra Devnet và lấy báo giá mới.'
      : 'Phantom không hoàn tất bước ký. Mở khóa ví, chọn Solana Devnet trong Testnet Mode, đóng yêu cầu đang chờ rồi lấy báo giá mới.'
    throw new Error(`Lỗi ký Phantom${detail}. ${reason} GoBuy chưa gửi giao dịch, chưa thực hiện mua.`, { cause })
  }
  // Snapshot the signed MESSAGE independently (never the signatures or raw wire bytes) and require a
  // valid Phantom signature. Every check must pass before the transaction reaches the backend.
  const sameTransactionObject = signed === transaction
  let after: MessageSnapshot
  try { after = snapshotTransaction(signed) }
  catch (cause) {
    console.error('[NaVault post-sign validation] signed transaction could not be read', cause)
    throw new Error('Post-sign validation failed: signed transaction could not be read. Transaction not submitted.', { cause })
  }
  console.log('[NaVault post-sign snapshot]\n' + JSON.stringify(after, null, 2))
  console.log('[NaVault signTransaction identity]\n' + JSON.stringify({ sameTransactionObject }, null, 2))
  const report = postSignReport(snapshot, after, signed, owner, wallet.publicKey?.toBase58())
  console.log('[NaVault message diff]\n' + JSON.stringify(report.diff, null, 2))
  if (!allPostSignChecksPass(report.checks)) {
    console.error('[NaVault post-sign validation]', report.checks)
    throw new Error(`Post-sign validation failed: ${failedPostSignChecks(report.checks).join(', ')}. ${describeMessageDiff(report.diff)} Transaction not submitted.`)
  }
  if (diagnostics?.cleanUnsigned) {
    const valid = signed.verifySignatures()
    console.log(`[NaVault debug ${diagnostics.trace}] clean signing result`, { signaturesValid: valid })
    if (!valid) throw new Error('Phantom returned without valid transaction signatures.')
  }
  await requireDevnet(connection)
  return signed
}
