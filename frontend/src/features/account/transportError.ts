export function accountTransportMessage(error: unknown): string | undefined {
  const name = (error as { name?: unknown } | null)?.name
  if (name === 'TimeoutError') return 'Máy chủ tải tài khoản phản hồi quá chậm (quá 15 giây). Hãy thử lại; lỗi này chưa cho thấy cấu hình Firebase sai.'
  if (name === 'AbortError') return 'Yêu cầu tải tài khoản đã bị hủy. Hãy thử lại.'
  return undefined
}
