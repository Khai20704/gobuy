import { z } from 'zod'
export const pairedSessionSchema = z.object({ token: z.string().regex(/^[a-f0-9]{64}$/), expiresAt: z.iso.datetime() }).strict()
// Credentials are scoped API sessions; LLM keys exist only on the backend.
export async function backendRequest(path: string, method: string, body?: unknown, token?: string, fetcher: typeof fetch = fetch) {
  try {
    const response = await fetcher(__API_ORIGIN__ + '/api/extension' + path, { method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body), credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(240000) })
    if (response.status === 401) throw new Error('Pairing expired or invalid. Connect from GoBuy again.')
    if (!response.ok) throw new Error('GoBuy could not complete the request. Check the backend and retry.')
    return response.status === 204 ? null : await response.json() as unknown
  } catch (error) {
    if (error instanceof Error && /^(Pairing|GoBuy)/.test(error.message)) throw error
    throw new Error('GoBuy backend is unavailable. Your budget and wallet have not changed.')
  }
}
