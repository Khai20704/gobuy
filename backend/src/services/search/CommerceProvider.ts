import type { CandidateItem, PurchaseIntent } from '@gobuy/shared'
import type { SearchProvider } from './SearchProvider.js'
import { toSearchIntent } from './commerceIntent.js'

export type CommerceResult = CandidateItem
export interface CommerceProvider {
  search(intent: PurchaseIntent, signal?: AbortSignal): Promise<CommerceResult[]>
}
// Reuses the existing bounded search adapters without duplicating verification logic.
export class CommerceProviderAdapter implements CommerceProvider {
  constructor(private readonly provider: SearchProvider) {}
  search(intent: PurchaseIntent, signal = AbortSignal.timeout(8000)) {
    const search = toSearchIntent(intent)
    if (this.provider.unavailable?.(search)) return Promise.resolve([])
    return this.provider.search(search, signal)
  }
}
