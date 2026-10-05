import { useEffect, useState } from 'react'
import { naRequestSchema, type NaRequest } from '@gobuy/shared'
import { accountFetch } from '../../account/firebase'
import { explorerTx } from '../../../services/solana/links'
import './requestHistory.css'

const statusLabel: Record<NaRequest['status'], string> = {
  PROCESSING: 'Đang xử lý',
  NEEDS_INPUT: 'Cần thêm thông tin',
  NO_MATCH: 'Không tìm thấy món phù hợp',
  QUOTED: 'Đã có báo giá',
  PENDING: 'Đang chờ giao dịch',
  CONFIRMED: 'Đã mua',
  FAILED: 'Chưa hoàn tất',
  NOT_SUBMITTED: 'Chưa gửi giao dịch',
}

export function RequestHistory({ revision }: { revision: number }) {
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
  return <details className="chat-request-history">
    <summary>Lịch sử yêu cầu {busy ? '· Đang tải…' : `· ${requests.length}`}</summary>
    {error && <p role="alert">{error} <button type="button" onClick={() => setRetry(value => value + 1)}>Thử lại</button></p>}
    {!error && requests.length === 0 && !busy && <p>Chưa có yêu cầu nào được lưu.</p>}
    <div>{requests.map(request => <article key={request.id}>
      <strong>{statusLabel[request.status]}{request.title ? ` · ${request.title}` : ''}</strong>
      <time dateTime={request.createdAt}>{new Date(request.createdAt).toLocaleString()}</time>
      <p>{request.prompt}</p>
      {request.response && <p>{request.response}</p>}
      {request.signature && <a href={explorerTx(request.signature)} target="_blank" rel="noreferrer">Xem giao dịch devnet ↗</a>}
    </article>)}</div>
  </details>
}
