import type { Transaction } from '@solana/web3.js'
import { PublicKey } from '@solana/web3.js'
import { connectPhantom, phantomProvider, type PhantomProvider } from './phantom'
import { devnetConnection, requireDevnet } from './network'
import { signDevnetTransaction } from './walletSafety'

export interface WalletProvider {
  readonly name: 'phantom' | 'embedded'
  connect(): Promise<string>
  getAddress(): string | null
  getBalance(): Promise<number>
  signTransaction(transaction: Transaction): Promise<Transaction>
}
export class PhantomWalletProvider implements WalletProvider {
  readonly name = 'phantom'
  private provider?: PhantomProvider
  async connect() { this.provider = await phantomProvider(); return (await connectPhantom(this.provider)).publicKey.toBase58() }
  getAddress() { return this.provider?.publicKey?.toBase58() ?? null }
  async getBalance() {
    const address = this.getAddress(); if (!address) throw new Error('Kết nối lại ví để tiếp tục.')
    const connection = devnetConnection(); await requireDevnet(connection)
    return connection.getBalance(new PublicKey(address), 'confirmed')
  }
  async signTransaction(transaction: Transaction) {
    if (!this.provider) throw new Error('Địa chỉ đã lưu không có quyền ký. Kết nối lại ví.')
    return signDevnetTransaction(this.provider, transaction)
  }
}
export class EmbeddedWalletProvider implements WalletProvider {
  readonly name = 'embedded'
  getAddress() { return null }
  private unavailable(): never { throw new Error('GoBuy Wallet đang chờ tích hợp nhà cung cấp embedded wallet an toàn. Chưa tạo ví hoặc quyền ký.') }
  async connect(): Promise<string> { return this.unavailable() }
  async getBalance(): Promise<number> { return this.unavailable() }
  async signTransaction(_transaction: Transaction): Promise<Transaction> { return this.unavailable() }
}
