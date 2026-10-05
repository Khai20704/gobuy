import { InputError } from '../../schemas/search.js'
import { fetchJson, ProviderRequestError, type Fetcher } from '../search/http.js'
export class JupiterClient {
  constructor(private readonly key = process.env.JUPITER_API_KEY, private readonly fetcher: Fetcher = fetch) {}
  async request(path: 'order' | 'execute', params: Record<string, string>) {
    try {
      return await fetchJson(`https://api.jup.ag/swap/v2/${path}${path === 'order' ? '?' + new URLSearchParams(params) : ''}`, {
        method: path === 'order' ? 'GET' : 'POST', signal: AbortSignal.timeout(10000),
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...(this.key ? { 'x-api-key': this.key } : {}) },
        ...(path === 'execute' ? { body: JSON.stringify(params) } : {}),
      }, this.fetcher)
    } catch (error) {
      if (error instanceof ProviderRequestError) {
        const reason = error.code === 'AUTHENTICATION_FAILED' ? 'Jupiter từ chối API key.'
          : error.code === 'ACCESS_FORBIDDEN' ? 'API key không có quyền dùng endpoint Jupiter.'
            : error.code === 'RATE_LIMITED' ? 'Jupiter đang giới hạn lượt truy cập.'
              : error.code === 'INVALID_RESPONSE' ? 'Jupiter trả dữ liệu không đúng định dạng.'
                : error.code === 'RESPONSE_TOO_LARGE' ? 'Phản hồi Jupiter vượt giới hạn an toàn.'
                : error.code === 'TIMEOUT' ? 'Jupiter phản hồi quá thời gian.'
                  : error.code === 'NO_DATA' ? 'Jupiter không trả dữ liệu.'
                    : 'Jupiter hiện không khả dụng.'
        throw new InputError(`${reason} Chưa xác nhận giao dịch.`)
      }
      throw new InputError('Jupiter chưa sẵn sàng hoặc không có route hợp lệ. Chưa xác nhận giao dịch.')
    }
  }
}
