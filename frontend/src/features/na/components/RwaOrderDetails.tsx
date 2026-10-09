import type { RWAOrder, RWAReply } from '@gobuy/shared'
import { purchasePhaseLabel } from './RequestHistory'
import { explorerAccount, explorerTx } from '../../../services/solana/links'

/** Vietnamese labels for the RWA order state machine; unknown states fall back to the raw value. */
const rwaOrderStatusLabel: Record<string, string> = {
  WAITING_FOR_PRICE: 'Đang chờ giá',
  EXECUTING: 'Điều kiện giá đã đạt. Na đang xác minh policy và execution quote.',
  EXECUTION_UNAVAILABLE: 'RWA đã được xác minh nhưng giao dịch này chưa có route thực thi trên Devnet.',
  CONFIRMED: 'Đã xác nhận', FAILED: 'Thất bại', EXPIRED: 'Hết hạn', CANCELLED: 'Đã huỷ',
}
/** A stored quantity is atomic, so it is shown as the decimal the user typed. */
function formatUnits(value: string | undefined, decimals: number) {
  if (!value) return '?'
  const base = 10n ** BigInt(decimals), raw = BigInt(value)
  const fraction = (raw % base).toString().padStart(decimals, '0').replace(/0+$/, '')
  return fraction ? `${raw / base}.${fraction}` : (raw / base).toString()
}
const currencyDecimals = (currency: string | undefined) => currency === 'USDC' ? 6 : 9

type Props = { reply: RWAReply; busy: boolean; onEvaluate: (orderId: string) => void }

export function RwaOrderDetails({ reply, busy, onEvaluate }: Props) {
  const order: RWAOrder | undefined = reply.order
  if (!order) return reply.delivery ? <div className="chat-rwa-order">
    <p>{purchasePhaseLabel[reply.delivery.phase]}</p>
    <p>{reply.delivery.quantity} token Devnet demo · không đại diện quyền sở hữu RWA thật.</p>
    {reply.delivery.mint && <a href={explorerAccount(reply.delivery.mint)} target="_blank" rel="noreferrer">Mint Devnet ↗</a>}{' · '}
    {reply.delivery.signature && <a href={explorerTx(reply.delivery.signature)} target="_blank" rel="noreferrer">Giao dịch giao token ↗</a>}
  </div> : null
  const spent = order.orderType === 'QUANTITY'
    ? `${formatUnits(order.quantity, reply.asset?.decimals ?? 0)} ${order.symbol} (trần ${formatUnits(order.maxTotalSpend, currencyDecimals(order.maxSpendCurrency))} ${order.maxSpendCurrency ?? ''})`
    : `${formatUnits(order.spendAmount, currencyDecimals(order.spendCurrency))} ${order.spendCurrency ?? ''}`
  return <div className="chat-rwa-order">
    <p><strong>{order.symbol}</strong> · {spent}</p>
    {order.condition && <p>Điều kiện: giá {'<'} {order.condition.targetPrice} {order.condition.priceCurrency}</p>}
    {order.observation?.observedPrice != null && <p>Giá hiện tại: {order.observation.observedPrice} {order.condition?.priceCurrency ?? 'USD'}</p>}
    <p>Trạng thái: {rwaOrderStatusLabel[order.status] ?? order.status}</p>
    {order.execution && <p>{order.execution.reason}</p>}
    {order.status === 'WAITING_FOR_PRICE' && <button disabled={busy} onClick={() => onEvaluate(order.id)}>Kiểm tra lại giá và policy</button>}
  </div>
}
