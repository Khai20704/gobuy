import { z } from 'zod'
import { researchResponseSchema, pageContextSchema, actionLogSchema, type PurchaseIntent, type PageContext } from '@gobuy/shared'
export async function message(type: string, body?: unknown) {
  const response = z.object({ ok: z.boolean(), value: z.unknown().optional(), error: z.string().optional() }).parse(await chrome.runtime.sendMessage({ type, body }))
  if (!response.ok) throw new Error(response.error ?? 'Na is unavailable.')
  return response.value
}
export async function search(text: string, structuredIntent?: PurchaseIntent, pageContext?: PageContext) {
  const { jobId } = z.object({ jobId: z.uuid() }).parse(await message('search', { text, structuredIntent, pageContext }))
  return resumeSearch(jobId)
}
export async function resumeSearch(jobId: string) {
  for (let attempt = 0; attempt < 240; attempt++) {
    const job = z.object({ status: z.enum(['PENDING', 'DONE', 'FAILED']), result: researchResponseSchema.optional() }).parse(await message('job', jobId))
    if (job.status === 'FAILED') { await chrome.storage.session.remove('pendingJob'); throw new Error('Research could not complete. Check your request and try again, or use structured search.') }
    if (job.status === 'DONE') {
      const result = researchResponseSchema.parse(job.result)
      await chrome.storage.session.set({ conversation: result }); await chrome.storage.session.remove('pendingJob')
      return result
    }
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
  throw new Error('Research is still pending. Reopen Na to resume, or inspect action history in GoBuy.')
}
export async function readPage() { return pageContextSchema.parse(await message('context')) }
export async function actions() { return z.array(actionLogSchema).parse(await message('actions')) }
