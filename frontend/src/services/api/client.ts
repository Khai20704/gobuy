import { searchResponseSchema, type SearchRequest } from '@gobuy/shared'
export async function discover(request: SearchRequest, signal?: AbortSignal) {
  const response = await fetch('/api/proposals/search', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request), signal: signal ?? AbortSignal.timeout(20000),
  })
  if (!response.ok) {
    const body = await response.json().catch(() => null)
    throw new Error(body?.error?.message ?? 'Proposal API unavailable. Start the backend on port 3001.')
  }
  return searchResponseSchema.parse(await response.json())
}
