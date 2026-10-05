import { accountFetch } from '../../features/account/firebase'
export async function investmentApi<T = unknown>(path: string, body?: unknown, method?: string): Promise<T> {
  const response = await accountFetch('/api/investment' + path, { method: method ?? (body === undefined ? 'GET' : 'POST'),
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(60000) })
  if (response.status === 204) return undefined as T
  const value = await response.json().catch(() => null)
  if (!response.ok || !value) throw new Error(value?.error?.message || 'Dịch vụ NFT/RWA chưa sẵn sàng. Chưa xác nhận giao dịch.')
  return value as T
}
