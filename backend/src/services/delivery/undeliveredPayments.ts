import type { UndeliveredPayment } from '@gobuy/shared'
import { assetStore, type AssetStore } from '../../persistence/AssetStore.js'
import type { AutonomousPurchaseOrder } from '../acquisition/AutonomousPurchaseService.js'
import type { RWAChatPlan } from '../rwa/RWAChatSettlement.js'
import type { DeliveryPlan } from './DeliveryService.js'

/** Read-only explanation of paid orders that never reached asset delivery. Does not mint or repay. */
export async function undeliveredPayments(user: string, stores: {
  nft: Pick<AssetStore<AutonomousPurchaseOrder>, 'list'>;
  rwa: Pick<AssetStore<RWAChatPlan>, 'list'>;
  delivery: Pick<AssetStore<DeliveryPlan>, 'list'>;
} = { nft: assetStore('autonomousPurchases'), rwa: assetStore('rwaChatSettlements'), delivery: assetStore('deliveryPlans') }): Promise<UndeliveredPayment[]> {
  const [nfts, rwas, deliveries] = await Promise.all([stores.nft.list(user), stores.rwa.list(user), stores.delivery.list(user)])
  const delivered = new Set(deliveries.map(plan => `${plan.kind}:${plan.paymentSignature}`))
  const rows: UndeliveredPayment[] = []
  for (const order of nfts) {
    const result = order.reply.result
    if (result.status !== 'CONFIRMED' || !result.signature || delivered.has('NFT:' + result.signature)) continue
    rows.push({ id: order.reply.id, kind: 'NFT', owner: order.owner, name: order.reply.selected.name,
      paymentSignature: result.signature, amountLamports: order.reply.actualSpendLamports ?? order.reply.requestedSpendLamports,
      reason: 'Đã chi SOL demo nhưng chưa có giao dịch giao NFT. Khoản thanh toán demo không tự giải phóng NFT từ người bán hoặc escrow. Chưa xác nhận sở hữu; không thanh toán lại.',
    })
  }
  for (const plan of rwas) {
    if (plan.result?.status !== 'CONFIRMED' || !plan.result.signature || delivered.has('RWA:' + plan.result.signature)) continue
    rows.push({ id: plan.reference, kind: 'RWA', owner: plan.owner, name: plan.symbol,
      paymentSignature: plan.result.signature, amountLamports: plan.amount,
      reason: plan.delivery ? 'Đã thanh toán nhưng chưa bắt đầu giao token. Kiểm tra lại yêu cầu mua để tiếp tục giao, không thanh toán lại.'
        : 'Đơn demo cũ chỉ chi SOL, chưa cấp token RWA. Thiếu kế hoạch giá/số lượng đã lưu để giao tự động; cần đối soát đơn cũ, không thanh toán lại.',
    })
  }
  return rows
}
