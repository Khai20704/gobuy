import { createHash } from 'node:crypto'
import { PublicKey, SendTransactionError, Transaction } from '@solana/web3.js'
import {
  base58Encode, checkMandateSpend, explainMandateRejection, formatSol, remainingBudget,
  type MandateCategory, type MandateSpendRecord, type MandateSpendResponse,
} from '@gobuy/shared'
import { InputError } from '../../schemas/search.js'
import { serializeMandate } from './MandateGuard.js'
import type { MandateProgramClient } from './MandateProgramClient.js'
import { decodeSpendRecord } from './spendRecords.js'
import { hexBytes, spendFromMandateInstruction, spendRecordAddress } from './mandateInstructions.js'
import { recordSpendNote } from './mandateNotes.js'
import { explainTransactionFailure, rejectionCodeOf } from './programErrors.js'
import { spendFailureDetail } from './spendFailureDetail.js'

/**
 * Na's autonomous Devnet settlement step.
 *
 * The owner's wallet is not involved: the vault PDA signs the transfer and GoBuy's Devnet agent
 * signs as the authorized executor and pays fees/rent. Every rule is re-checked by the program, so the pre-check below exists
 * to explain a refusal before a fee is spent — never to grant a spend.
 */

export type VaultSpendRequest = {
  userId: string
  owner: string
  amountLamports: bigint
  category: Exclude<MandateCategory, 'ANY'>
  /** 32-byte hex identity of the selected asset; part of the idempotency key for this settlement. */
  assetHash: string
  reference: string
}

/**
 * Deterministic spend id, so replaying the same purchase cannot create a second receipt and cannot
 * double-spend the vault. The program enforces the same rule through `init` on `["spend", ...]`.
 */
export function spendIdFor(mandate: string, assetHash: string, amountLamports: bigint, reference: string): string {
  return createHash('sha256')
    .update(mandate + ':' + assetHash + ':' + amountLamports.toString() + ':' + reference)
    .digest('hex').slice(0, 32)
}

export async function executeVaultSpend(client: MandateProgramClient, request: VaultSpendRequest): Promise<MandateSpendResponse> {
  const agent = client.agent
  if (!agent) {
    throw new InputError('Chưa cấu hình ví agent Devnet (NA_AGENT_KEYPAIR). Na chưa thể chi tiêu tự động từ vault; không có giao dịch nào được gửi.')
  }
  hexBytes(request.assetHash, 32, 'assetHash')
  if (request.amountLamports <= 0n) throw new InputError('Số tiền chi tiêu phải lớn hơn 0.')
  const mandate = await client.read(request.owner)
  if (!mandate) throw new InputError('Ví này chưa có mandate trên Solana Devnet. Hãy ủy quyền ngân sách cho Na trước khi mua.')

  const mandateKey = new PublicKey(mandate.address)
  const spendId = spendIdFor(mandate.address, request.assetHash, request.amountLamports, request.reference)
  const spend = spendRecordAddress(client.programId, mandateKey, hexBytes(spendId, 16, 'spendId'))
  // Idempotency: an existing receipt means this exact purchase already settled.
  if (await client.connection.getAccountInfo(spend, 'confirmed')) {
    return alreadySettled(client, spend.toBase58(), request)
  }

  if (mandate.executor !== agent.publicKey.toBase58()) throw new InputError('Agent does not match the authorized executor.')
  const verdict = checkMandateSpend({ mandate, amountLamports: request.amountLamports, category: request.category,
    nowSeconds: Math.floor(Date.now() / 1000), vaultLamports: mandate.vaultLamports })
  if (!verdict.allowed) {
    return { signature: null, status: 'FAILED', rejection: verdict.rejection, spend: null,
      message: explainMandateRejection(verdict.rejection, { amountLamports: request.amountLamports,
        remainingLamports: remainingBudget(mandate.maxBudgetLamports, mandate.spentLamports) }),
      mandate: serializeMandate(mandate) }
  }

  const transaction = new Transaction({ feePayer: agent.publicKey, ...await client.connection.getLatestBlockhash('confirmed') })
    .add(spendFromMandateInstruction(client.programId, agent.publicKey, {
      mandate: mandateKey, vault: new PublicKey(mandate.vault), recipient: new PublicKey(mandate.recipient),
      amountLamports: request.amountLamports, category: request.category, spendId, assetHash: request.assetHash,
    }))
  transaction.sign(agent)

  let signature: string
  try {
    signature = await client.broadcast(transaction)
  } catch (error) {
    if (rejectionCodeOf(error) || error instanceof SendTransactionError && error.message.startsWith('Simulation failed.')) return failure(client, request, error, null)
    return { signature: transaction.signature ? base58Encode(transaction.signature) : null, status: 'PENDING', rejection: null, spend: null, mandate: serializeMandate(mandate), message: 'Chưa xác định được kết quả. Kiểm tra Explorer/lịch sử; giữ nguyên mã khoản chi khi thử lại. RPC: ' + spendFailureDetail(error) }
  }
  let logs: readonly string[] | null
  try { logs = await client.confirm(signature, transaction.recentBlockhash, transaction.lastValidBlockHeight) }
  catch (error) { return { signature, status: 'PENDING', rejection: null, spend: null, mandate: serializeMandate(mandate), message: 'Đang chờ xác nhận. Kiểm tra Explorer/lịch sử; giữ nguyên mã khoản chi khi thử lại. RPC: ' + spendFailureDetail(error) } }
  if (logs) return failure(client, request, { logs }, signature)

  const record = await client.connection.getAccountInfo(spend, 'confirmed')
  if (!record || !record.owner.equals(client.programId)) {
    return { signature, status: 'PENDING', rejection: null, spend: null, mandate: serializeMandate(await client.read(request.owner)),
      message: 'Giao dịch đã xác nhận nhưng chưa đọc được biên nhận. Kiểm tra Explorer và lịch sử; không tạo khoản chi mới.' }
  }
  const receipt = decodeSpendRecord(spend.toBase58(), record.data)
  await recordSpendNote(request.userId, { spendId, owner: request.owner, reference: request.reference,
    assetHash: request.assetHash, signature, amountLamports: request.amountLamports.toString(),
    createdAt: new Date().toISOString() }).catch(() => { /* The chain receipt remains authoritative. */ })
  return { signature, status: 'CONFIRMED', rejection: null, message: describeSpend(request, BigInt(receipt.spentBeforeLamports), BigInt(receipt.spentAfterLamports) + BigInt(receipt.remainingAfterLamports)),
    spend: { ...receipt, signature, reference: request.reference },
    mandate: serializeMandate(await client.read(request.owner)) }
}

async function alreadySettled(client: MandateProgramClient, address: string,
  request: VaultSpendRequest): Promise<MandateSpendResponse> {
  const record = await client.connection.getAccountInfo(new PublicKey(address), 'confirmed')
  if (!record || !record.owner.equals(client.programId)) throw new InputError('Chưa đọc được biên nhận hợp lệ. Kiểm tra lịch sử trước khi thử lại.')
  return { signature: null, status: 'CONFIRMED', rejection: null, spend: record ? { ...decodeSpendRecord(address, record.data), reference: request.reference } : null,
    message: 'Giao dịch chi tiêu này đã được ghi nhận trên Solana Devnet trước đó. Na không gửi lại để tránh chi trùng.',
    mandate: serializeMandate(await client.read(request.owner)) }
}

async function failure(client: MandateProgramClient, request: VaultSpendRequest, error: unknown,
  signature: string | null): Promise<MandateSpendResponse> {
  return { signature, status: 'FAILED', rejection: rejectionCodeOf(error) ?? 'TransactionFailed', spend: null,
    message: explainTransactionFailure(error, { amountLamports: request.amountLamports }) + '\n' + spendFailureDetail(error),
    mandate: serializeMandate(await client.read(request.owner)) }
}

function describeSpend(request: VaultSpendRequest, spentBefore: bigint, maxBudget: bigint): string {
  return 'Na đã chi ' + formatSol(request.amountLamports) + ' SOL từ Na Vault cho "' + request.reference +
    '". Hạn mức còn lại: ' + formatSol(remainingBudget(maxBudget, spentBefore + request.amountLamports)) + ' SOL.'
}

export type { MandateSpendRecord }
