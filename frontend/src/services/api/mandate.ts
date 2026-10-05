import { accountFetch } from '../../features/account/firebase'

export async function mandateApi(path: string, body?: unknown): Promise<unknown> {
  const response = await accountFetch('/api/mandate' + path, {
    method: body === undefined ? 'GET' : 'POST',
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(65000),
  })
  const value = await response.json()
  if (!response.ok) throw new Error(value?.error?.message || 'Chưa xác định được trạng thái Na Vault. Kiểm tra lại trước khi gửi giao dịch mới.')
  return value
}
