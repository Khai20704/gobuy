import type { CandidateItem, SearchIntent } from '@gobuy/shared'

export interface SearchProvider {
  readonly name: string
  readonly mode: 'real' | 'mock'
  readonly timeoutMs?: number
  readonly requiresLLM?: boolean
  // Return a reason when not configured or not applicable to this intent.
  unavailable?(intent: SearchIntent): string | undefined
  search(intent: SearchIntent, signal: AbortSignal): Promise<CandidateItem[]>
}
