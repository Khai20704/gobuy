import { ComputeBudgetProgram, PublicKey, Transaction, TransactionInstruction } from '@solana/web3.js'
import { assertDevnet, base58Encode, createNftPurchaseAuthorizationInputSchema, formatSol, solToLamports,
  type CreateNftPurchaseAuthorizationInput } from '@gobuy/shared'
import { InputError } from '../../schemas/search.js'
import { requiredMandateClient, type MandateProgramClient } from '../mandate/MandateProgramClient.js'
import { createNftPurchaseAuthorizationInstruction } from './nftPurchaseInstructions.js'

/**
 * The owner's one-time approval of a versioned original-NFT purchase policy.
 *
 * This is a separate, explicit signature. The settlement mandate the owner already funded is never
 * silently reinterpreted as permission to buy NFTs from arbitrary sellers: without this account the
 * genuine-purchase instruction cannot be reached at all.
 *
 * No pending state is kept. The transaction is rebuilt deterministically from the owner's input and
 * the submitted instruction is compared against it, so nothing can be substituted in between.
 */

export type NftPurchaseAuthorizationAction = 'authorize_nft'

export type UnsignedNftPurchaseAuthorization = {
  action: NftPurchaseAuthorizationAction
  owner: string
  authorization: string
  transaction: string
  expiresAt: string
  summary: string
}

export type NftPurchaseAuthorizationSubmit = {
  action: NftPurchaseAuthorizationAction
  status: 'CONFIRMED' | 'FAILED' | 'PENDING'
  signature: string | null
  message: string
}

const TTL_MS = 120_000
const COMPUTE_BUDGET_PROGRAM = 'ComputeBudget111111111111111111111111111111'

export class NftPurchaseAuthorizationClient {
  constructor(private readonly client: () => MandateProgramClient = requiredMandateClient) {}

  private async context(owner: string, input: CreateNftPurchaseAuthorizationInput) {
    const client = this.client()
    await assertDevnet(client.connection, { network: 'devnet', rpcUrl: client.connection.rpcEndpoint })
    const agent = client.agent
    if (!agent) throw new InputError('Chưa cấu hình ví agent Devnet, nên chưa uỷ quyền mua NFT gốc được.')
    const parsed = createNftPurchaseAuthorizationInputSchema.safeParse({ maxTotalDebitSol: input.maxTotalDebitSol, expiresInHours: input.expiresInHours })
    if (!parsed.success) throw new InputError('Hạn mức uỷ quyền mua NFT không hợp lệ.')
    const ownerKey = ownerPublicKey(owner)
    const mandate = await client.read(owner)
    if (!mandate) throw new InputError('Ví này chưa có mandate trên Solana Devnet. Hãy uỷ quyền ngân sách trước.')
    if (!mandate.active || mandate.closed) throw new InputError('Mandate không còn hoạt động. Na không tạo uỷ quyền mua NFT.')
    const maxTotalDebitLamports = solToLamports(parsed.data.maxTotalDebitSol)
    if (maxTotalDebitLamports > mandate.maxBudgetLamports - mandate.spentLamports) {
      throw new InputError('Hạn mức mua NFT vượt ngân sách còn lại của mandate.')
    }
    if (mandate.expiresAt <= Math.floor(Date.now() / 1000)) throw new InputError('Mandate đã hết hạn. Chưa tạo uỷ quyền mua NFT.')
    return { client, agent, ownerKey, parsed: parsed.data, maxTotalDebitLamports, mandate }
  }

  /** Deterministic approval transaction, returned unsigned for Phantom. */
  async build(owner: string, input: CreateNftPurchaseAuthorizationInput): Promise<UnsignedNftPurchaseAuthorization> {
    const { client, agent, ownerKey, parsed, maxTotalDebitLamports, mandate } = await this.context(owner, input)
    const expiresAt = Math.min(mandate.expiresAt, Math.floor(Date.now() / 1000) + parsed.expiresInHours * 3600)
    const instruction = createNftPurchaseAuthorizationInstruction(client.programId, ownerKey,
      { maxTotalDebitLamports, expiresAt, executor: agent.publicKey, recipient: ownerKey })
    const transaction = new Transaction({ feePayer: ownerKey, ...await client.connection.getLatestBlockhash('confirmed') })
      .add(instruction, ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 10_000 }))
    return {
      action: 'authorize_nft',
      owner: ownerKey.toBase58(),
      authorization: instruction.keys[2].pubkey.toBase58(),
      transaction: Buffer.from(transaction.serialize({ requireAllSignatures: false, verifySignatures: false })).toString('base64'),
      expiresAt: new Date(Date.now() + TTL_MS).toISOString(),
      summary: 'Uỷ quyền mua NFT gốc: Na chỉ được dùng Na Vault trả cho listing Tensor đã xác minh, tối đa '
        + formatSol(maxTotalDebitLamports) + ' SOL, và NFT gốc luôn được chuyển vào ví Phantom của bạn.',
    }
  }

  /** Verifies the wallet signed exactly this approval, then broadcasts it once. */
  async submit(owner: string, input: CreateNftPurchaseAuthorizationInput, signedBase64: string): Promise<NftPurchaseAuthorizationSubmit> {
    const { client, agent, ownerKey, parsed, maxTotalDebitLamports, mandate } = await this.context(owner, input)
    let submitted: Transaction
    try { submitted = Transaction.from(Buffer.from(signedBase64, 'base64')) }
    catch { throw new InputError('Giao dịch uỷ quyền đã ký không đọc được. Na không gửi giao dịch.') }
    const expected = createNftPurchaseAuthorizationInstruction(client.programId, ownerKey,
      { maxTotalDebitLamports, expiresAt: 0, executor: agent.publicKey, recipient: ownerKey })
    const actual = submitted.instructions.filter(instruction =>
      !instruction.programId.equals(new PublicKey(COMPUTE_BUDGET_PROGRAM)))
    if (!submitted.verifySignatures() || submitted.feePayer?.toBase58() !== ownerKey.toBase58()
      || actual.length !== 1 || !sameAccounts(expected, actual[0]) || actual[0].data.length !== 8 + 8 + 8 + 96) {
      throw new InputError('Chữ ký hoặc nội dung uỷ quyền mua NFT không khớp yêu cầu. Na không gửi giao dịch.')
    }
    const limit = actual[0].data.readBigUInt64LE(8)
    const expiresAt = Number(actual[0].data.readBigInt64LE(16))
    const upperBound = Math.min(mandate.expiresAt, Math.floor(Date.now() / 1000) + parsed.expiresInHours * 3600 + 300)
    if (limit !== maxTotalDebitLamports || !actual[0].data.subarray(24, 120).equals(expected.data.subarray(24, 120))
      || expiresAt <= Math.floor(Date.now() / 1000) || expiresAt > upperBound) {
      throw new InputError('Nội dung uỷ quyền mua NFT đã bị thay đổi so với yêu cầu. Na không gửi giao dịch.')
    }
    // Only bounded wallet-added compute settings are accepted; no extra signers or fee transfers.
    const compute = submitted.instructions.filter(ix => ix.programId.toBase58() === COMPUTE_BUDGET_PROGRAM)
    const tags = new Set<number>()
    for (const ix of compute) {
      const tag = ix.data[0]
      if (ix.keys.length || tags.has(tag) || !((tag === 2 && ix.data.length === 5 && ix.data.readUInt32LE(1) > 0 && ix.data.readUInt32LE(1) <= 1_400_000)
        || (tag === 3 && ix.data.length === 9 && ix.data.readBigUInt64LE(1) <= 10_000n))) {
        throw new InputError('Compute budget không hợp lệ hoặc vượt mức phí cho phép.')
      }
      tags.add(tag)
    }
    if (submitted.signatures.length !== 1 || submitted.serialize().length > 1232) throw new InputError('Giao dịch uỷ quyền không hợp lệ.')
    const signature = base58Encode(submitted.signature!)
    try { await client.broadcast(submitted) } catch (error) {
      if ((error as Error)?.message?.startsWith('Simulation failed.')) return { action: 'authorize_nft', status: 'FAILED', signature,
        message: 'Devnet từ chối uỷ quyền trước khi gửi. Không có quyền mua nào được ghi.' }
      return { action: 'authorize_nft', status: 'PENDING', signature,
        message: 'Chưa rõ kết quả gửi uỷ quyền. Kiểm tra chữ ký ban đầu; không ký lại.' }
    }
    // A serialized wallet transaction does not carry lastValidBlockHeight. Never invent it.
    let status
    try { status = (await client.connection.getSignatureStatuses([signature], { searchTransactionHistory: true })).value[0] } catch { /* pending */ }
    if (status?.confirmationStatus === 'finalized' && status.err) {
      return { action: 'authorize_nft', status: 'FAILED', signature,
        message: 'Giao dịch uỷ quyền mua NFT không hoàn tất trên Devnet. Không có quyền mua nào được ghi.' }
    }
    return { action: 'authorize_nft', status: status?.confirmationStatus === 'finalized' && !status.err ? 'CONFIRMED' : 'PENDING', signature,
      message: 'Đã gửi uỷ quyền. Đọc lại tài khoản uỷ quyền finalized trước khi mua; không ký lại khi chưa rõ kết quả.' }
  }
}

/** Same program, same canonical accounts. The expiry slot is checked separately, on the data. */
function sameAccounts(expected: TransactionInstruction, actual: TransactionInstruction): boolean {
  return expected.programId.equals(actual.programId)
    && Buffer.from(expected.data.subarray(0, 8)).equals(Buffer.from(actual.data.subarray(0, 8)))
    && expected.keys.length === actual.keys.length
    && expected.keys.every((key, index) => key.pubkey.equals(actual.keys[index].pubkey)
      && key.isSigner === actual.keys[index].isSigner && key.isWritable === actual.keys[index].isWritable)
}

function ownerPublicKey(value: string): PublicKey {
  try {
    const key = new PublicKey(value)
    if (!PublicKey.isOnCurve(key.toBytes())) throw new Error('not on curve')
    return key
  } catch { throw new InputError('Địa chỉ ví không hợp lệ hoặc không phải ví Solana.') }
}
