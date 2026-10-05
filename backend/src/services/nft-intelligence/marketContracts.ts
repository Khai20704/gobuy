import type { NFTCandidate, NFTResearch } from '@gobuy/shared'
import type { ProviderFailureCode } from '../search/http.js'
export type ResolvedNFTCollection = { name: string; symbol: string; collectionAddress?: string; source: string; verified?: boolean }
export type ProviderCapability = { listings: boolean; collectionResolution: boolean; activities: boolean; stats: boolean; authenticatedFeatures: boolean }
export type ProviderDiagnostic = { provider: string; endpoint: string; network: string; httpStatus?: number; latencyMs: number;
  receivedRows?: number; acceptedRows?: number; schemaRejectedRows?: number; budgetRejectedRows?: number; finalCandidateCount?: number; failureCode?: ProviderFailureCode }
export type NFTProviderResult = { candidates: NFTCandidate[]; warnings?: string[];
  status?: 'SUCCESS' | 'PARTIAL_DATA' | 'NO_MATCH' | 'COLLECTION_NOT_FOUND' | 'COLLECTION_AMBIGUOUS' | 'COLLECTION_UNRESOLVED' | 'NO_ASSETS_FOUND' | 'INSUFFICIENT_MARKET_DATA' | 'MAINNET_READ_ONLY';
  research?: NFTResearch;
  resolvedCollection?: ResolvedNFTCollection; ambiguousCollections?: ResolvedNFTCollection[];
  diagnostics?: ProviderDiagnostic[]; coverage?: { listingsChecked?: number; activitiesChecked?: number; collectionsChecked?: number } }
export class CollectionAmbiguityError extends Error {
  readonly code = 'COLLECTION_AMBIGUOUS'
  constructor(readonly matches: ResolvedNFTCollection[]) { super('Multiple matching collection identities.') }
}
