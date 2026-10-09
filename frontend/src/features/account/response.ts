import { accountProfileSchema } from '@gobuy/shared'

// Retry only this read, never account updates, OTP requests or purchases.
export async function loadAccountProfile(request: () => Promise<Response>,
  isCurrent = () => true, wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))) {
  for (let attempt = 0; ; attempt++) {
    if (!isCurrent()) throw new Error('Account request superseded')
    let response: Response
    try { response = await request() }
    catch (error) {
      const timedOut = (error as { name?: unknown } | null)?.name === 'TimeoutError'
      if (!(error instanceof TypeError) && !timedOut || attempt >= (timedOut ? 1 : 3)) throw error
      await wait((attempt + 1) * 1000)
      continue
    }
    if ([500, 502, 503, 504].includes(response.status) && attempt < 3) {
      await response.body?.cancel()
      await wait((attempt + 1) * 1000)
      continue
    }
    return readAccountResponse(response)
  }
}

export async function readAccountResponse(response: Response) {
  const fallback = `Không nhận được phản hồi hợp lệ từ máy chủ (HTTP ${response.status}). Vui lòng thử lại.`
  let data: unknown
  try { data = await response.json() }
  catch { throw new Error(fallback) }
  if (!response.ok) {
    const error = data && typeof data === 'object' && 'error' in data ? data.error : null
    const message = error && typeof error === 'object' && 'message' in error ? error.message : null
    throw new Error(typeof message === 'string' && message ? message : fallback)
  }
  const profile = accountProfileSchema.safeParse(data)
  if (!profile.success) throw new Error(fallback)
  return profile.data
}
