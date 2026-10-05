import { VersionedTransaction, PublicKey, Connection } from '@solana/web3.js'
import { createPublicKey, verify } from 'node:crypto'
import { z } from 'zod'
import { InputError } from '../../schemas/search.js'
import { JupiterClient } from './JupiterClient.js'
import type { JupiterOrder } from './types.js'
export class JupiterSwapService {
  constructor(private readonly client = new JupiterClient(), private readonly rpc = new Connection(process.env.RWA_SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com', 'confirmed')) {}
  async validate(order: JupiterOrder, wallet: string, feeReserve: number) {
    if (!order.transaction || !order.requestId) throw new InputError('Jupiter chưa tạo được transaction.')
    const tx = VersionedTransaction.deserialize(Buffer.from(order.transaction, 'base64'))
    if (tx.message.staticAccountKeys[0].toBase58() !== wallet) throw new InputError('Transaction không thuộc ví được cấp quyền.')
    if ([order.signatureFeeLamports, order.prioritizationFeeLamports, order.rentFeeLamports].some(value => value === undefined)
      || (order.signatureFeeLamports! + order.prioritizationFeeLamports! + order.rentFeeLamports!) > feeReserve) throw new InputError('Phí swap chưa xác định hoặc vượt phần dự phòng policy.')
    if (await this.rpc.getGenesisHash() !== '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp') throw new InputError('RPC RWA không phải Solana mainnet.')
    const simulation = await this.rpc.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true })
    if (simulation.value.err) throw new InputError('Mô phỏng swap thất bại; kiểm tra số dư và điều kiện chuyển token của issuer.')
  }
  verifySigned(order: JupiterOrder, signed: string, wallet: string) {
    const original = VersionedTransaction.deserialize(Buffer.from(order.transaction!, 'base64'))
    const tx = VersionedTransaction.deserialize(Buffer.from(signed, 'base64'))
    if (!Buffer.from(tx.message.serialize()).equals(Buffer.from(original.message.serialize()))) throw new InputError('Transaction đã bị thay đổi sau khi Na duyệt.')
    const index = tx.message.staticAccountKeys.findIndex(key => key.toBase58() === wallet)
    if (index !== 0 || index >= tx.message.header.numRequiredSignatures) throw new InputError('Sai ví ký giao dịch.')
    const key = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), new PublicKey(wallet).toBuffer()]), type: 'spki', format: 'der' })
    if (!verify(null, tx.message.serialize(), key, tx.signatures[index])) throw new InputError('Chữ ký Phantom không hợp lệ.')
  }
  async execute(order: JupiterOrder, signed: string) {
    return z.object({ status: z.enum(['Success', 'Failed']), signature: z.string().optional(), code: z.number() })
      .parse(await this.client.request('execute', { requestId: order.requestId!, signedTransaction: signed }))
  }
  async status(signature: string) {
    const row = (await this.rpc.getSignatureStatuses([signature], { searchTransactionHistory: true })).value[0]
    return row?.err ? 'FAILED' : row?.confirmationStatus === 'confirmed' || row?.confirmationStatus === 'finalized' ? 'CONFIRMED' : 'PENDING'
  }
}
