import { accountFetch } from '../../features/account/firebase'

export class AcquisitionApiError extends Error {
  constructor(message: string, readonly executionStarted: boolean | undefined) { super(message) }
}

export async function acquisitionApi(path: string, body?: unknown): Promise<unknown> {
  const response = await accountFetch('/api/acquisition' + path, { method: body === undefined ? 'GET' : 'POST',
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(60000) })
  if (response.status === 204) return undefined
  const value = await response.json().catch(() => null)
  if (!response.ok || !value) throw new AcquisitionApiError(value?.error?.message || 'Dịch vụ tìm NFT chưa sẵn sàng. Kiểm tra giao dịch đang chờ trước khi thử lại.',
    value?.error?.code === 'AUTONOMOUS_SPEND_BLOCKED' && value.error.executionStarted === false ? false : undefined)
  return value
}
