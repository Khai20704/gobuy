import { NFTPurchaseError } from '../../nft/errors.js'
import { HeliusNFTProvider } from '../../nft/helius/HeliusNFTProvider.js'
import { TensorMarketplaceClient } from '../../nft/tensor/TensorMarketplaceClient.js'
import { type NFTCandidate, type NftDemoQuote, type NftDemoReceipt, solanaConfig, assertDevnet } from '@gobuy/shared'
import { tensorMarketplaceProgram, type TensorBuyInstruction } from '@gobuy/tensor-adapter'
import { PublicKey, Transaction, TransactionInstruction, VersionedTransaction, Connection } from '@solana/web3.js'
import { base58 } from '@metaplex-foundation/umi/serializers'
import { resolve } from 'node:path'
import { InputError } from '../../schemas/search.js'
import { FileOrderStore, MongoOrderStore, type OrderStore } from '../../persistence/OrderStore.js'
import { storageMode } from '../../persistence/mongo.js'
import { type ExecutionEngine } from './ExecutionEngine.js'
import { DevnetSimulationExecutor } from './ExecutionEngine.js'
import { acquisitionConfig, acquisitionLog } from './discovery.js'

const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'

export function toWeb3JsTensorInstruction(instruction: TensorBuyInstruction) {
  if (instruction.programAddress !== tensorMarketplaceProgram) throw new InputError('Tensor SDK returned an unexpected program address.')
  return new TransactionInstruction({
    programId: new PublicKey(instruction.programAddress),
    keys: instruction.accounts.map(account => ({
      pubkey: new PublicKey(account.address),
      isSigner: account.isSigner,
      isWritable: account.isWritable,
    })),
    data: Buffer.from(instruction.data),
  })
}

export class TensorDevnetExecutor implements ExecutionEngine {
  private readonly connection: Connection
  private readonly locks = new Set<string>()
  private readonly config = solanaConfig(process.env)
  private readonly store: OrderStore

  constructor(store?: OrderStore, rpcUrl = this.config.rpcUrl,
    private readonly ordersDirectory = resolve(process.env.TENSOR_ORDER_DATA_DIR || '.data/tensor-orders')) {
    if (rpcUrl !== this.config.rpcUrl) throw new Error('Tensor RPC must match SOLANA_RPC_URL.')
    this.connection = new Connection(rpcUrl, { commitment: 'confirmed', disableRetryOnRateLimit: true })
    this.store = store ?? (storageMode() === 'file' ? new FileOrderStore(this.ordersDirectory) : new MongoOrderStore())
    acquisitionConfig()
  }

  private async devnet() {
    solanaConfig(process.env)
    acquisitionConfig()
    try { await assertDevnet(this.connection, this.config) }
    catch (cause) { throw new InputError('Không xác minh được Solana Devnet. Đã chặn giao dịch Tensor.', { cause }) }
  }

  async prepare(id: string, candidate: NFTCandidate, maximumLamports: number, owner: string, userId: string) {
    assertNFTExecutionNetwork(candidate)
    if (candidate.provider !== 'tensor' || candidate.sourceNetwork !== 'devnet' || !candidate.mint || !candidate.listing.seller) {
      throw new InputError('Tensor chỉ hỗ trợ listing Devnet đã xác minh đủ mint và người bán.')
    }
    if (!Number.isSafeInteger(maximumLamports) || maximumLamports <= 0) throw new InputError('Ngân sách mua Tensor không hợp lệ.')
    if (this.locks.has(id)) throw new InputError('Yêu cầu đang được xử lý.')
    this.locks.add(id)
    try {
      const existing = await this.store.read(id)
      if (existing) {
        if (existing.userId !== userId || existing.quote.owner !== owner
          || existing.quote.sourceAsset?.id !== candidate.id || existing.quote.simulated !== false) {
          throw new InputError('Yêu cầu này đã được dùng cho ví hoặc tài sản khác.')
        }
        return { status: 'READY' as const, message: 'Giao dịch Tensor Devnet đã được chuẩn bị. Kiểm tra listing và tổng chi trong Phantom trước khi ký.', quote: existing.quote }
      }
      await this.devnet()
      const buyer = new PublicKey(owner)
      if (!PublicKey.isOnCurve(buyer.toBytes())) throw new InputError('Ví Phantom không hợp lệ.')
      const maximum = BigInt(maximumLamports)
      if (!candidate.marketplaceListing) throw new NFTPurchaseError('LISTING_UNAVAILABLE')
      await new HeliusNFTProvider().verifyOwner(candidate.mint, candidate.marketplaceListing.listingId, AbortSignal.timeout(15000))
      if (BigInt(candidate.marketplaceListing.priceLamports) > maximum) throw new NFTPurchaseError('PRICE_CHANGED')
      const plan = await new TensorMarketplaceClient(this.config.rpcUrl).buildPurchase(candidate.marketplaceListing, owner, AbortSignal.timeout(15000))
      const instructionData = plan.instructions[0]
      if (instructionData.mint !== candidate.mint || instructionData.seller !== candidate.listing.seller
        || instructionData.priceLamports !== candidate.listing.priceLamports) {
        throw new InputError('Listing đã đổi kể từ lúc tìm kiếm. Chưa tạo giao dịch; tìm listing lại.')
      }
      const balance = await this.connection.getBalance(buyer, 'confirmed')
      const latestBlockhash = await this.connection.getLatestBlockhash('confirmed')
      const transaction = new Transaction({ feePayer: buyer, ...latestBlockhash })
        .add(toWeb3JsTensorInstruction(instructionData))
      const fee = (await this.connection.getFeeForMessage(transaction.compileMessage(), 'confirmed')).value
      if (fee === null) throw new InputError('Chưa tính được phí giao dịch Tensor trên Devnet.')
      const wire = transaction.serialize({ requireAllSignatures: false })
      const simulation = await this.connection.simulateTransaction(VersionedTransaction.deserialize(wire), {
        sigVerify: false,
        accounts: { encoding: 'base64', addresses: [owner] },
        commitment: 'confirmed',
      })
      if (simulation.value.err || !simulation.value.accounts?.[0]) {
        acquisitionLog('tensor_quote', { provider: 'tensor', outcome: 'simulation_failed' })
        throw new InputError('Giao dịch Tensor không vượt qua mô phỏng Devnet. Chưa gửi gì vào mạng; listing có thể không còn hợp lệ.')
      }
      const estimatedTotalLamports = balance - simulation.value.accounts[0].lamports + fee
      const priceLamports = Number(instructionData.priceLamports)
      if (!Number.isSafeInteger(estimatedTotalLamports) || estimatedTotalLamports <= 0
        || estimatedTotalLamports > maximumLamports || estimatedTotalLamports > balance
        || priceLamports > maximumLamports) {
        return { status: 'NO_MATCH' as const, message: 'Giá Tensor cộng phí vượt ngân sách hoặc số dư Devnet. Chưa tạo giao dịch.' }
      }
      const quote: NftDemoQuote = {
        id,
        network: 'devnet',
        owner,
        asset: candidate.mint,
        title: candidate.name,
        image: candidate.image ?? '',
        priceLamports,
        maximumLamports,
        estimatedTotalLamports,
        transaction: wire.toString('base64'),
        expiresAt: new Date(Date.now() + 90_000).toISOString(),
        sourceAsset: candidate,
        simulated: false,
      }
      await this.store.create({ text: `Tensor Devnet purchase ${candidate.mint}`, quote, userId })
      acquisitionLog('tensor_quote', { provider: 'tensor', outcome: 'ready' })
      return { status: 'READY' as const, message: `Đã chuẩn bị giao dịch mua listing thật trên Tensor Devnet: ${candidate.name}. Đây chỉ là dữ liệu listing on-chain, không xác nhận độ phổ biến hay giá trị đầu tư. Phantom sẽ yêu cầu bạn ký; chưa có giao dịch nào được gửi.`, quote }
    } finally {
      this.locks.delete(id)
    }
  }

  async submit(id: string, signedBase64: string, userId: string): Promise<NftDemoReceipt> {
    if (this.locks.has(id)) throw new InputError('Giao dịch đang được xử lý; kiểm tra trạng thái thay vì gửi lại.')
    this.locks.add(id)
    try {
      await this.devnet()
      const order = await this.store.read(id)
      if (!order || order.userId !== userId || order.quote.simulated !== false
        || order.quote.sourceAsset?.provider !== 'tensor') throw new InputError('Không tìm thấy báo giá Tensor Devnet của tài khoản này.')
      if (order.signature) return this.status(id, userId)
      if (Date.parse(order.quote.expiresAt) <= Date.now()) throw new InputError('Báo giá Tensor đã hết hạn. Lấy listing và báo giá mới.')
      const prepared = Transaction.from(Buffer.from(order.quote.transaction, 'base64'))
      const signed = Transaction.from(Buffer.from(signedBase64, 'base64'))
      if (!prepared.serializeMessage().equals(signed.serializeMessage()) || !signed.verifySignatures()
        || !signed.signature || signed.feePayer?.toBase58() !== order.quote.owner) {
        throw new InputError('Chữ ký Phantom hoặc nội dung giao dịch Tensor không khớp báo giá.')
      }
      const candidate = order.quote.sourceAsset
      if (!candidate?.marketplaceListing || !candidate.mint || !candidate.listing.seller) throw new NFTPurchaseError('LISTING_UNAVAILABLE')
      await new HeliusNFTProvider().verifyOwner(candidate.mint, candidate.marketplaceListing.listingId, AbortSignal.timeout(15000))
      await new TensorMarketplaceClient(this.config.rpcUrl).buildPurchase(candidate.marketplaceListing, order.quote.owner, AbortSignal.timeout(15000))
      const [signature] = base58.deserialize(signed.signature)
      order.signature = signature
      order.signed = signedBase64
      if (!await this.store.submit(order)) return this.status(id, userId)
      await this.devnet()
      try {
        await this.connection.sendRawTransaction(signed.serialize(), { skipPreflight: false, maxRetries: 2 })
      } catch {
        return this.status(id, userId)
      }
      return this.status(id, userId)
    } finally {
      this.locks.delete(id)
    }
  }

  async status(id: string, userId: string): Promise<NftDemoReceipt> {
    await this.devnet()
    const order = await this.store.read(id)
    if (!order || order.userId !== userId || order.quote.simulated !== false
      || order.quote.sourceAsset?.provider !== 'tensor') throw new InputError('Không tìm thấy giao dịch Tensor của tài khoản này.')
    if (!order.signature) return { status: 'NOT_SUBMITTED', message: 'Chưa có giao dịch Tensor được gửi.' }
    const result = await this.connection.getTransaction(order.signature, {
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0,
    })
    if (!result?.meta) return { status: 'PENDING', signature: order.signature, asset: order.quote.asset,
      message: 'Giao dịch Tensor đã ký; đang chờ xác nhận Devnet. Không mua lại trong lúc chờ.' }
    if (result.meta.err) return { status: 'FAILED', signature: order.signature, asset: order.quote.asset,
      message: 'Giao dịch Tensor Devnet thất bại; NFT chưa được xác nhận là đã mua. Phí mạng có thể đã bị trừ.' }
    const feePayerIndex = result.transaction.message.getAccountKeys().staticAccountKeys
      .findIndex(key => key.toBase58() === order.quote.owner)
    if (feePayerIndex < 0) return { status: 'PENDING', signature: order.signature, asset: order.quote.asset,
      message: 'Không xác minh được ví trả phí của giao dịch. Cần kiểm tra thủ công; không mua lại.' }
    const totalLamports = result.meta.preBalances[feePayerIndex] - result.meta.postBalances[feePayerIndex]
    if (!Number.isSafeInteger(totalLamports) || totalLamports <= 0 || totalLamports > order.quote.maximumLamports) {
      return { status: 'PENDING', signature: order.signature, asset: order.quote.asset,
        message: 'Tổng chi chưa khớp ngân sách đã xác nhận. Cần kiểm tra giao dịch trên Explorer; không mua lại.' }
    }
    const owned = await this.connection.getParsedTokenAccountsByOwner(new PublicKey(order.quote.owner), {
      mint: new PublicKey(order.quote.asset),
    }, 'confirmed')
    const received = owned.value.some(account => {
      const data = account.account.data
      return 'parsed' in data && data.parsed.type === 'account'
        && data.parsed.info.tokenAmount.amount === '1'
        && data.parsed.info.tokenAmount.decimals === 0
    })
    if (!received) return { status: 'PENDING', signature: order.signature, asset: order.quote.asset,
      totalLamports, message: 'Giao dịch đã xác nhận nhưng NFT chưa xuất hiện trong ví theo kiểm tra token account. Cần kiểm tra thủ công; không mua lại.' }
    return { status: 'CONFIRMED', signature: order.signature, asset: order.quote.asset, totalLamports,
      message: `Đã mua ${order.quote.title} trên Tensor Devnet và xác nhận NFT trong ví Phantom. Tổng chi ${totalLamports / 1e9} SOL Devnet.` }
  }

  async assetOwner(asset: string): Promise<string> {
    await this.devnet()
    const mint = new PublicKey(asset)
    const mintInfo = await this.connection.getAccountInfo(mint, 'confirmed')
    if (!mintInfo || ![TOKEN_PROGRAM, TOKEN_2022_PROGRAM].includes(mintInfo.owner.toBase58())) {
      throw new UnsupportedTensorAssetError('Asset is not an SPL token mint.')
    }
    const largest = await this.connection.getTokenLargestAccounts(mint, 'confirmed')
    for (const tokenAccount of largest.value) {
      if (tokenAccount.amount !== '1') continue
      const account = await this.connection.getParsedAccountInfo(tokenAccount.address, 'confirmed')
      const data = account.value?.data
      if (!data || !('parsed' in data) || data.parsed.type !== 'account') continue
      return data.parsed.info.owner
    }
    return ''
  }

  async hasOrder(id: string, userId: string) {
    const order = await this.store.read(id)
    return order?.userId === userId && order.quote.simulated === false
      && order.quote.sourceAsset?.provider === 'tensor'
  }
}

export class UnsupportedTensorAssetError extends Error {}

export class TensorAwareExecutionEngine implements ExecutionEngine {
  constructor(private readonly simulation = new DevnetSimulationExecutor(), private readonly tensor = new TensorDevnetExecutor()) {}

  prepare(id: string, candidate: NFTCandidate, maximumLamports: number, owner: string, userId: string) {
    assertNFTExecutionNetwork(candidate)
    if (candidate.provider !== 'tensor' && candidate.sourceNetwork !== 'mock') throw new NFTPurchaseError('SIGNING_UNAVAILABLE')
    return candidate.provider === 'tensor'
      ? this.tensor.prepare(id, candidate, maximumLamports, owner, userId)
      : this.simulation.prepare(id, candidate, maximumLamports, owner, userId)
  }

  async submit(id: string, signed: string, userId: string) {
    return await this.tensor.hasOrder(id, userId)
      ? this.tensor.submit(id, signed, userId)
      : this.simulation.submit(id, signed, userId)
  }

  async status(id: string, userId: string) {
    return await this.tensor.hasOrder(id, userId)
      ? this.tensor.status(id, userId)
      : this.simulation.status(id, userId)
  }

  async assetOwner(asset: string) {
    try { return await this.tensor.assetOwner(asset) }
    catch (error) {
      if (error instanceof UnsupportedTensorAssetError) return this.simulation.assetOwner(asset)
      throw error
    }
  }
}
import { assertNFTExecutionNetwork } from './executionNetwork.js'
