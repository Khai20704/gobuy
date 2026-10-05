import { z } from 'zod'
import { ProviderFailure, providerHttpFailure } from '../errors/classifyProviderError.js'
export type Fetcher = typeof fetch

async function readBody(response: Response): Promise<unknown> {
  const reader = response.body?.getReader()
  if (!reader) throw new ProviderFailure('invalid_output')
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      const part = await reader.read()
      if (part.done) break
      length += part.value.length
      if (length > 2_000_000) throw new ProviderFailure('invalid_output')
      chunks.push(part.value)
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown }
    catch { throw new ProviderFailure('invalid_output') }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
}

export async function providerJson(url: string, init: RequestInit, fetcher: Fetcher): Promise<unknown> {
  let response: Response
  try { response = await fetcher(url, { ...init, redirect: 'error' }) }
  catch (error) {
    if (init.signal?.aborted) throw new ProviderFailure('timeout')
    if (error instanceof TypeError || error instanceof Error && /^(?:ECONN|ENOTFOUND|ETIMEDOUT)/.test(String((error as NodeJS.ErrnoException).code))) throw new ProviderFailure('connection')
    throw error
  }
  let body: unknown
  try { body = await readBody(response) }
  catch (error) {
    if (init.signal?.aborted) throw new ProviderFailure('timeout')
    if (!response.ok) throw providerHttpFailure(response.status, undefined)
    if (error instanceof TypeError) throw new ProviderFailure('connection')
    throw error
  }
  if (!response.ok) throw providerHttpFailure(response.status, body)
  return body
}

export function parseResponse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value)
  if (!parsed.success) throw new ProviderFailure('invalid_output')
  return parsed.data
}
