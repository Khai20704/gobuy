import { nftPurchaseResultSchema, serializedNftPurchaseAuthorizationSchema, type CreateNftPurchaseAuthorizationInput } from '@gobuy/shared'
import { accountFetch } from '../../features/account/firebase'

async function request(path: string, body?: unknown) {
  const response = await accountFetch('/api/nft-purchases' + path, { method: body === undefined ? 'GET' : 'POST',
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(65000) })
  const value = await response.json()
  if (!response.ok) throw new Error(value?.error?.message || 'Chưa xác định được kết quả. Giữ mã đơn và kiểm tra lại; không mua lại.')
  return value
}
export const nftPurchaseApi = {
  async config(): Promise<{ liveExecutionEnabled: boolean }> {
    const value = await request('/config')
    if (value.network !== 'devnet' || value.deliveryMode !== 'ORIGINAL_NFT_TRANSFER' || value.demoFallback !== false
      || typeof value.liveExecutionEnabled !== 'boolean') throw new Error('Cấu hình mua NFT không hợp lệ.')
    return value
  },
  async authorization(owner: string) {
    const value = await request('/authorization?owner=' + encodeURIComponent(owner))
    return value.authorization === null ? null : serializedNftPurchaseAuthorizationSchema.parse(value.authorization)
  },
  async buildAuthorization(owner: string, input: CreateNftPurchaseAuthorizationInput): Promise<{ owner: string; transaction: string; expiresAt: string }> {
    const value = await request('/authorization', { owner, ...input })
    if (value.owner !== owner || value.action !== 'authorize_nft' || typeof value.transaction !== 'string'
      || !Number.isFinite(Date.parse(value.expiresAt))) throw new Error('Yêu cầu ký uỷ quyền không hợp lệ.')
    return value
  },
  async submitAuthorization(owner: string, input: CreateNftPurchaseAuthorizationInput, transaction: string): Promise<{ status: 'CONFIRMED' | 'PENDING' | 'FAILED'; signature: string | null; message: string }> {
    const value = await request('/authorization/submit', { owner, ...input, transaction })
    if (!['CONFIRMED', 'PENDING', 'FAILED'].includes(value.status) || typeof value.message !== 'string') throw new Error('Chưa rõ kết quả uỷ quyền; không ký lại.')
    return value
  },
  async purchase(discoveryId: string, candidateId: string, owner: string) {
    return nftPurchaseResultSchema.parse(await request('/purchase', { discoveryId, candidateId, owner }))
  },
  async status(discoveryId: string) { return nftPurchaseResultSchema.parse(await request('/purchases/' + encodeURIComponent(discoveryId))) },
}
