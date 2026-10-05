import { commerceTwinSchema, researchResponseSchema, decisionResponseSchema,
  type PurchaseIntent, type DecisionInput, type TwinPreferences } from '@gobuy/shared'
import { apiUrl } from './baseUrl'

async function request(path: string, method = 'GET', body?: unknown) {
  const response = await fetch(apiUrl('/api/research' + path), {
    method, credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(300000),
  })
  if (!response.ok) {
    const error = await response.json().catch(() => null)
    throw new Error(error?.error?.message ?? 'Na research is unavailable. Check the backend and try again.')
  }
  return response.json() as Promise<unknown>
}
export async function researchProducts(text: string, previousSearchId?: string, structuredIntent?: PurchaseIntent) { return researchResponseSchema.parse(await request('/search', 'POST', { text, previousSearchId, structuredIntent })) }
let twinRequest: Promise<ReturnType<typeof commerceTwinSchema.parse>> | undefined
export function getCommerceTwin() {
  // React StrictMode can mount twice; share the first request so it establishes one cookie.
  twinRequest ??= request('/twin').then(value => commerceTwinSchema.parse(value)).finally(() => { twinRequest = undefined })
  return twinRequest
}
export async function saveTwinPreferences(preferences: TwinPreferences) { return commerceTwinSchema.parse(await request('/twin', 'PATCH', preferences)) }
export async function decideRecommendation(input: DecisionInput) { return decisionResponseSchema.parse(await request('/decisions', 'POST', input)) }
