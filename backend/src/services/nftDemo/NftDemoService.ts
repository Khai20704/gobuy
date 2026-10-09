import { devnetRpc } from '../delivery/rpc.js'
import { FileOrderStore, MongoOrderStore, type OrderStore } from '../../persistence/OrderStore.js'
import { createHash } from 'node:crypto'
import { storageMode } from '../../persistence/mongo.js'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, VersionedTransaction } from '@solana/web3.js'
import { createUmi } from '@metaplex-foundation/umi-bundle-defaults'
import { createNoopSigner, createSignerFromKeypair, publicKey } from '@metaplex-foundation/umi'
import { base58 } from '@metaplex-foundation/umi/serializers'
import { createV1, fetchAssetV1, mplCore } from '@metaplex-foundation/mpl-core'
import { toWeb3JsInstruction } from '@metaplex-foundation/umi-web3js-adapters'
import { solanaConfig, assertDevnet, type NftDemoQuote, type NftDemoReceipt, type NFTCandidate } from '@gobuy/shared'
import { InputError } from '../../schemas/search.js'
import { selectDemoArt } from './catalog.js'


import { resolveDemoBuy } from './budget.js'
import { SolExchangeRates, type ExchangeRateProvider } from '../currency/SolExchangeRates.js'

export const simulationMetadataId = (userId: string, id: string) => createHash('sha256').update(JSON.stringify([userId, id])).digest('hex')

export class NftDemoService {
  private readonly connection: Connection
  private readonly umi: ReturnType<typeof createUmi>
  private readonly locks = new Set<string>()
  private readonly directory: string
  private readonly store: OrderStore
  constructor(directory: string | undefined = undefined, rpc = solanaConfig(process.env).rpcUrl,
    private readonly publicBase = process.env.NFT_DEMO_PUBLIC_URL || 'http://localhost:3001',
    private readonly rates: ExchangeRateProvider = new SolExchangeRates(process.env.COINGECKO_API_KEY), store?: OrderStore) {
    this.directory = directory ?? resolve(process.env.NFT_DATA_DIR || '.data/nft-demo')
    this.store = store ?? (directory || storageMode() === 'file' ? new FileOrderStore(this.directory) : new MongoOrderStore())
    if (rpc !== solanaConfig(process.env).rpcUrl) throw new Error('RPC must match SOLANA_RPC_URL')
    this.connection = devnetRpc(rpc)
    this.umi = createUmi(rpc).use(mplCore())
  }
  private async devnet() {
    try { await assertDevnet(this.connection, solanaConfig(process.env)) }
    catch { throw new InputError('Không xác minh được RPC Solana Devnet. Giao dịch đã bị chặn; hãy kiểm tra cấu hình hoặc kết nối RPC. Đây không phải kết quả kiểm tra mạng trong Phantom.') }
  }
  private async seller() {
    await mkdir(this.directory, { recursive: true })
    const path = resolve(this.directory, 'demo-seller-keypair.json')
    try { await writeFile(path, JSON.stringify([...Keypair.generate().secretKey]), { flag: 'wx', mode: 0o600 }) }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e }
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(await readFile(path, 'utf8')))).publicKey
  }
  async prepare(id: string, text: string, owner: string, userId?: string) {
    return this.build(id, text, owner, userId)
  }
  async prepareRepresentation(id: string, candidate: NFTCandidate, maximumLamports: number, owner: string, userId: string) {
    assertNFTExecutionNetwork(candidate)
    return this.build(id, `Devnet simulation: ${candidate.id}`, owner, userId, { candidate, maximumLamports })
  }
  async assetOwner(asset: string) {
    await this.devnet()
    return (await fetchAssetV1(this.umi, publicKey(asset))).owner.toString()
  }
  private async build(id: string, text: string, owner: string, userId?: string, selection?: { candidate: NFTCandidate; maximumLamports: number }) {
    const parsed = selection ? { maximumLamports: selection.maximumLamports, topic: undefined, conversion: undefined } : await resolveDemoBuy(text, this.rates)
    if ('message' in parsed) return { status: 'NEEDS_INPUT' as const, message: parsed.message }
    const art = selection ? { id, name: selection.candidate.name, priceLamports: Number(selection.candidate.listing.priceLamports) } : selectDemoArt(parsed.maximumLamports, parsed.topic)
    if (!art || art.priceLamports + 20_000_000 > parsed.maximumLamports) return { status: 'NO_MATCH' as const,
      message: parsed.topic && !art
        ? 'Không tìm được tranh đúng chủ đề trong Na Demo Gallery với ngân sách này. Catalog chỉ có 4 tranh mẫu: trừu tượng, biển, hoàng hôn và rừng; chưa tìm trên marketplace bên ngoài. Na chưa tạo giao dịch, chưa chi SOL.'
        : 'Không tìm được tranh demo phù hợp ngân sách và phần dự phòng phí. Na chưa tạo giao dịch, chưa chi SOL.' }
    if (!owner) return { status: 'NEEDS_INPUT' as const, message: 'Kết nối Phantom để Na kiểm tra số dư devnet và mua tranh. SOL trên testnet không dùng được trên devnet.' }
    if (this.locks.has(id)) throw new InputError('Yêu cầu đang được xử lý.')
    this.locks.add(id)
    try {
      const existing = await this.store.read(id)
      if (existing) {
        if (existing.userId !== userId) throw new InputError('Order belongs to another account.')
        if (existing.text !== text || existing.quote.owner !== owner) throw new InputError('Mã yêu cầu đã được sử dụng.')
        return { status: 'READY' as const, message: 'Giao dịch đã được chuẩn bị cho yêu cầu này.', quote: existing.quote }
      }
      const buyer = new PublicKey(owner)
      if (!PublicKey.isOnCurve(buyer.toBytes())) throw new InputError('Ví không hợp lệ.')
      await this.devnet()
      const balance = await this.connection.getBalance(buyer)
      if (balance < art.priceLamports + 20_000_000) throw new InputError(`Ví có ${balance / 1e9} SOL trên devnet. Cần khoảng ${(art.priceLamports + 20_000_000) / 1e9} SOL gồm dự phòng phí. Kiểm tra đúng mạng devnet trong Phantom.`)
      const mint = Keypair.generate()
      const asset = createSignerFromKeypair(this.umi, this.umi.eddsa.createKeypairFromSecretKey(mint.secretKey))
      const payer = createNoopSigner(publicKey(owner))
      const uri = `${this.publicBase.replace(/\/$/, '')}${selection ? '/api/acquisition/metadata/' + simulationMetadataId(userId!, id) : '/api/nft-demo/metadata/' + art.id}`
      const builder = createV1(this.umi, { asset, payer, authority: payer, owner: payer.publicKey,
        updateAuthority: payer.publicKey, name: `Na ${selection ? 'Simulation' : 'Demo'} - ${art.name}`.slice(0, 80), uri })
      const block = await this.connection.getLatestBlockhash()
      const transaction = new Transaction({ feePayer: buyer, ...block })
        .add(...builder.getInstructions().map(toWeb3JsInstruction))
        .add(SystemProgram.transfer({ fromPubkey: buyer, toPubkey: await this.seller(), lamports: art.priceLamports }))
      await this.devnet()
      transaction.partialSign(mint)
      const fee = (await this.connection.getFeeForMessage(transaction.compileMessage())).value
      if (fee === null) throw new InputError('Chưa tính được phí devnet. Chưa gửi giao dịch.')
      const wire = transaction.serialize({ requireAllSignatures: false })
      const simulation = await this.connection.simulateTransaction(VersionedTransaction.deserialize(wire), {
        sigVerify: false, accounts: { encoding: 'base64', addresses: [owner] }, commitment: 'confirmed',
      })
      if (simulation.value.err || !simulation.value.accounts?.[0]) throw new InputError('Giao dịch tạo NFT demo không vượt qua kiểm tra devnet. Chưa chi SOL; thử lại sau.')
      // Add the fee conservatively even on RPCs whose simulation already deducts it.
      const total = balance - simulation.value.accounts[0].lamports + fee
      if (!Number.isSafeInteger(total) || total < art.priceLamports || total > parsed.maximumLamports || total > balance) {
        return { status: 'NO_MATCH' as const, message: 'Giá tranh cộng phí vượt ngân sách hoặc số dư. Na không gửi giao dịch.' }
      }
      const quote: NftDemoQuote = { conversion: 'conversion' in parsed ? parsed.conversion : undefined, id, network: 'devnet', owner, asset: mint.publicKey.toBase58(), title: art.name,
        image: selection?.candidate.image || `/api/nft-demo/art/${art.id}`, priceLamports: art.priceLamports, maximumLamports: parsed.maximumLamports,
        ...(selection ? { sourceAsset: selection.candidate, simulated: true as const } : {}),
        estimatedTotalLamports: total, transaction: wire.toString('base64'), expiresAt: new Date(Date.now() + 90_000).toISOString() }
      await this.store.create({ text, quote, userId })
      return { status: 'READY' as const, message: selection
        ? `Mô phỏng Devnet cho ${art.name}. Chỉ chi SOL thử nghiệm; NFT tạo ra không phải tài sản gốc trên ${selection.candidate.sourceNetwork}.`
        : `Na đã chọn ${art.name}. Xác nhận giao dịch trong Phantom để mua NFT demo.`, quote }
    } finally { this.locks.delete(id) }
  }
  async submit(id: string, signedBase64: string, userId?: string, allowRepresentation = false): Promise<NftDemoReceipt> {
    if (this.locks.has(id)) throw new InputError('Giao dịch đang được xử lý; kiểm tra trạng thái thay vì gửi lại.')
    this.locks.add(id)
    try {
      await this.devnet()
      const order = await this.store.read(id)
      if (!order) throw new InputError('Không tìm thấy yêu cầu mua.')
      if (order.userId !== userId) throw new InputError('Order belongs to another account.')
      if (order.quote.simulated && !allowRepresentation) throw new InputError('Giao dịch mô phỏng marketplace phải đi qua luồng xác minh listing mới.')
      if (order.signature) return this.status(id, userId)
      if (Date.parse(order.quote.expiresAt) < Date.now()) throw new InputError('Báo giá đã hết hạn. Chưa gửi giao dịch; hãy yêu cầu mua lại.')
      if (order.quote.conversion) {
        const refreshed = await resolveDemoBuy(order.text, this.rates)
        if ('message' in refreshed || order.quote.estimatedTotalLamports > refreshed.maximumLamports) {
          throw new InputError('Tỷ giá USD đã thay đổi hoặc không xác minh được ngân sách. Chưa gửi giao dịch; hãy lấy báo giá mới.')
        }
      }
      const prepared = Transaction.from(Buffer.from(order.quote.transaction, 'base64'))
      const signed = Transaction.from(Buffer.from(signedBase64, 'base64'))
      if (!prepared.serializeMessage().equals(signed.serializeMessage()) || !signed.verifySignatures() || !signed.signature) {
        throw new InputError('Chữ ký hoặc nội dung giao dịch không khớp báo giá.')
      }
      order.signature = base58.deserialize(signed.signature)[0]
      order.signed = signedBase64
      // Persist before submission: an uncertain response must never create a new purchase.
      if (!await this.store.submit(order)) return this.status(id, userId)
      await this.devnet()
      try { await this.connection.sendRawTransaction(signed.serialize(), { skipPreflight: false, maxRetries: 2 }) }
      catch { return { status: 'PENDING', signature: order.signature, asset: order.quote.asset, message: 'Chưa xác nhận được giao dịch. Na không mua lại; hãy kiểm tra trạng thái.' } }
      return this.status(id, userId)
    } finally { this.locks.delete(id) }
  }
  async status(id: string, userId?: string): Promise<NftDemoReceipt> {
    await this.devnet()
    const order = await this.store.read(id)
    if (order && order.userId !== userId) throw new InputError('Order belongs to another account.')
    if (!order?.signature) return { status: 'NOT_SUBMITTED', message: 'Chưa có giao dịch được gửi cho yêu cầu này.' }
    const receipt = await this.connection.getTransaction(order.signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 })
    const common = { signature: order.signature, asset: order.quote.asset }
    if (!receipt?.meta) return { ...common, status: 'PENDING', message: 'Đang chờ xác nhận devnet. Không gửi thêm yêu cầu mua cho giao dịch này.' }
    if (receipt.meta.err) return { ...common, status: 'FAILED', message: 'Giao dịch devnet thất bại; không mua được NFT. Phí mạng có thể đã bị trừ.' }
    const total = receipt.meta.preBalances[0] - receipt.meta.postBalances[0]
    const nft = await fetchAssetV1(this.umi, publicKey(order.quote.asset))
    if (nft.owner !== order.quote.owner || total > order.quote.maximumLamports) {
      return { ...common, status: 'PENDING', message: 'Cần kiểm tra giao dịch trên Explorer; quyền sở hữu hoặc tổng chi chưa khớp. Na không tự thử mua lại.' }
    }
    return { ...common, status: 'CONFIRMED', totalLamports: total,
      message: order.quote.simulated
        ? `Đã mô phỏng mua ${order.quote.title} trên Devnet. Tổng chi ${total / 1e9} SOL thử nghiệm. Bạn không sở hữu NFT gốc từ giao dịch này.`
        : `Đã mua ${order.quote.title} trên devnet. NFT đã về ví; tổng chi ${total / 1e9} SOL.` }
  }
}
import { assertNFTExecutionNetwork } from '../acquisition/executionNetwork.js'
