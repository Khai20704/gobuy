import type { DevnetDelivery } from '@gobuy/shared'
export function deliveryStatusLabel(delivery: DevnetDelivery) {
  if (delivery.phase === 'COMPLETED') return delivery.ownership === 'verified'
    ? 'Đã thanh toán · Quyền sở hữu đã xác minh trên Devnet · Chưa xác minh hiển thị trong Phantom Collectibles'
    : 'Đã thanh toán · Giao dịch giao tài sản đã hoàn tất · Chưa xác minh quyền sở hữu hiện tại hoặc hiển thị trong Phantom'
  if (delivery.deliveryMode === 'DEVNET_DEMO_MINT' && delivery.phase === 'DELIVERY_PENDING' && ['pending', 'preparing'].includes(delivery.recovery?.status ?? 'pending')) return 'Na đang tự động tạo và chuyển NFT demo vào ví Phantom của bạn.'
  if (delivery.recovery?.status !== 'requires_attention' && delivery.recovery?.lastError === 'RPC_RATE_LIMIT') return 'RPC đang bận · tự động thử lại'
  switch (delivery.recovery?.status) {
    case 'requires_attention': return 'Giao tài sản chưa hoàn tất · cần kiểm tra chi tiết'
    case 'submitted': return 'Đã gửi giao dịch giao NFT'
    case 'confirming': return 'Đang xác nhận giao NFT'
    case 'retrying': return 'Đã thanh toán · đang tự động thử lại việc giao tài sản'
    default: return 'Đã thanh toán · chờ giao NFT'
  }
}
export function deliveryPollingFinished(delivery?: DevnetDelivery) {
  return delivery?.phase === 'COMPLETED' || delivery?.recovery?.status === 'requires_attention'
}
