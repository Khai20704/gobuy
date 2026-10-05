import { createPublicKey, randomUUID, verify } from 'node:crypto'
import { PublicKey } from '@solana/web3.js'
import { type WalletAssociation } from '@gobuy/shared'
import { assetStore, type AssetStore } from '../../persistence/AssetStore.js'
import { InputError } from '../../schemas/search.js'
import { acquisitionLog } from './discovery.js'

type Challenge = { id: string; address: string; message: string; expiresAt: string }
export class WalletAssociationService {
  constructor(private readonly wallets: AssetStore<WalletAssociation> = assetStore('walletAssociations'),
    private readonly challenges: AssetStore<Challenge> = assetStore('walletChallenges'), private readonly now = () => Date.now()) {}
  async challenge(userId: string, address: string) {
    let key: PublicKey
    try { key = new PublicKey(address); if (!PublicKey.isOnCurve(key.toBytes())) throw new Error() }
    catch { throw new InputError('Địa chỉ ví Solana không hợp lệ.') }
    const id = randomUUID(), expiresAt = new Date(this.now() + 5 * 60000).toISOString()
    const message = `GoBuy wallet association\nApp account: ${userId}\nWallet: ${address}\nNetwork: solana:devnet\nNonce: ${id}\nExpires: ${expiresAt}\nThis signature links your wallet only. It does not authorize spending.`
    const challenge = { id, address, message, expiresAt }
    await this.challenges.put(userId, id, challenge, true)
    return challenge
  }
  async verify(userId: string, id: string, signature: string) {
    const challenge = await this.challenges.take(userId, id)
    if (!challenge || Date.parse(challenge.expiresAt) <= this.now()) throw new InputError('Yêu cầu xác minh đã hết hạn hoặc đã dùng. Kết nối lại ví.')
    const bytes = Buffer.from(signature, 'base64')
    const key = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), new PublicKey(challenge.address).toBuffer()]), format: 'der', type: 'spki' })
    if (bytes.length !== 64 || !verify(null, Buffer.from(challenge.message, 'utf8'), key, bytes)) throw new InputError('Chữ ký không khớp ví và yêu cầu xác minh.')
    const current = await this.wallets.get(userId, challenge.address), now = new Date(this.now()).toISOString()
    const wallet: WalletAssociation = { address: challenge.address, provider: 'phantom', network: 'devnet', verified: true, createdAt: current?.createdAt ?? now, lastUsedAt: now }
    await this.wallets.put(userId, wallet.address, wallet)
    acquisitionLog('wallet_verification', { outcome: 'verified' })
    return wallet
  }
  list(userId: string) { return this.wallets.list(userId) }
  async require(userId: string, address: string) {
    if (!(await this.wallets.get(userId, address))?.verified) throw new InputError('Kết nối ví và ký xác minh quyền sở hữu trước khi chuẩn bị mua.')
  }
}
