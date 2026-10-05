import { accountFetch } from '../../features/account/firebase'
export async function nftDemoApi(path: string, body?: unknown) {
  let response: Response
  try {
    response = await accountFetch('/api/nft-demo' + path, { method: body ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(60000) })
  } catch (error) {
    if (error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name)) {
      throw new Error('Backend phản hồi quá lâu. Kiểm tra kết nối rồi thử lại; nếu đã ký, hãy kiểm tra giao dịch đang chờ.')
    }
    throw new Error('Không kết nối được backend. Chạy npm run dev từ thư mục gobuy để mở cả frontend và backend.')
  }
  const value = await response.json().catch(() => null)
  if (!response.ok || value === null) {
    if (value?.error?.message) throw new Error(value.error.message)
    throw new Error(`Backend không phản hồi hợp lệ (HTTP ${response.status}). Chạy npm run dev từ thư mục gobuy và kiểm tra terminal backend.`)
  }
  return value
}
