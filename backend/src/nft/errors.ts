import { InputError } from '../schemas/search.js'
export type NFTPurchaseFailure = 'NO_MATCH' | 'ASSET_NOT_FOUND' | 'LISTING_UNAVAILABLE' | 'LISTING_CHANGED'
  | 'PRICE_CHANGED' | 'POLICY_REJECTED' | 'NETWORK_MISMATCH' | 'INSUFFICIENT_FUNDS' | 'SIGNING_UNAVAILABLE'
  | 'TRANSACTION_FAILED' | 'TRANSACTION_NOT_CONFIRMED'
export class NFTPurchaseError extends InputError {
  constructor(readonly code: NFTPurchaseFailure) {
    super(code)
  }
}
