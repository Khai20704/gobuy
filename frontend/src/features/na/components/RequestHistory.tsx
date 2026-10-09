import { useEffect, useState } from 'react'
import { naRequestSchema, type NaRequest, type PurchasePhase } from '@gobuy/shared'
import { accountFetch } from '../../account/firebase'
import { explorerTx } from '../../../services/solana/links'
import './requestHistory.css'

const statusLabel: Record<NaRequest['status'], string> = {
  PROCESSING: 'Đang xử lý',
  NEEDS_INPUT: 'Cần thêm thông tin',
  NO_MATCH: 'Không tìm thấy món phù hợp',
  QUOTED: 'Đã có báo giá',
  PENDING: 'Đang chờ giao dịch',
  CONFIRMED: 'Đã xác nhận giao dịch',
  FAILED: 'Chưa hoàn tất',
  NOT_SUBMITTED: 'Chưa gửi giao dịch',
}
export const purchasePhaseLabel: Record<PurchasePhase, string> = {
  PAYMENT_PENDING: 'Đang thanh toán', PAYMENT_CONFIRMED: 'Đã thanh toán', DELIVERY_PENDING: 'Đang giao tài sản',
  DELIVERY_CONFIRMED: 'Đã xác nhận nhận tài sản', COMPLETED: 'Thành công · đã nhận tài sản', DELIVERY_FAILED: 'Đã thanh toán · giao tài sản chưa hoàn tất',
}

/** A saved request, shown both in the "Lịch sử" tab and in Na's conversation history. */
export function RequestHistory({ revision, onOpen, opening }: { revision: number; onOpen: (request: NaRequest) => void; opening: boolean }) {
  const [requests, setRequests] = useState<NaRequest[]>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    let active = true
    setBusy(true)
    void accountFetch('/api/nft-demo/requests').then(async response => {
      if (!response.ok) throw new Error('Không tải được lịch sử yêu cầu.')
      const data = naRequestSchema.array().parse(await response.json())
      if (active) { setRequests(data); setError('') }
    }).catch(error => {
      if (active) setError(error instanceof Error ? error.message : 'Không tải được lịch sử yêu cầu.')
    }).finally(() => { if (active) setBusy(false) })
    return () => { active = false }
  }, [revision, retry])
  return <section className="na-history" aria-label="Lịch sử yêu cầu">
    <header className="na-panel-head">
      <div><h3>Lịch sử yêu cầu</h3><p>{busy ? 'Đang tải…' : `${requests.length} yêu cầu đã lưu`}</p></div>
      <button type="button" className="na-panel-refresh" disabled={busy} onClick={() => setRetry(value => value + 1)} aria-label="Tải lại lịch sử">
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M20 12a8 8 0 1 1-2.34-5.66M20 4v4h-4" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"/></svg>
        <span>Tải lại</span>
      </button>
    </header>
    {error && <p className="na-panel-error" role="alert">{error}</p>}
    {!error && requests.length === 0 && !busy && <p className="na-empty">Chưa có yêu cầu nào được lưu. Hãy hỏi Na tìm hoặc mua một tài sản.</p>}
    <div className="na-list">{requests.map(request => <article className="na-history-item" key={request.id}>
      <div className="na-history-head">
        <strong>{request.phase ? purchasePhaseLabel[request.phase] : request.status === 'CONFIRMED' && request.title === 'RWA · thanh toán demo Devnet' ? 'Đã chi demo' : statusLabel[request.status]}{request.title ? ` · ${request.title}` : ''}</strong>
        <time dateTime={request.createdAt}>{new Date(request.createdAt).toLocaleString('vi-VN')}</time>
      </div>
      <p>{request.prompt}</p>
      <button type="button" className="na-panel-refresh" disabled={opening} onClick={() => onOpen(request)}>Mở cuộc trò chuyện →</button>
      {request.response && <p className="na-history-response">{request.response}</p>}
      {request.signature && <a href={explorerTx(request.signature)} target="_blank" rel="noreferrer">Xem giao dịch devnet ↗</a>}
    </article>)}</div>
  </section>
}
