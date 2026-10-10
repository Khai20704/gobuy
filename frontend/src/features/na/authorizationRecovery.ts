import type { Connection } from '@solana/web3.js'

export type PendingAuthorization = { signature?: string; blockhash?: string; createdAt?: number }
export type AuthorizationOutcome = 'RETRY_SAFE' | 'CONFIRMED' | 'UNKNOWN'

// Absence of a status alone is not evidence of failure. All reads must succeed.
export async function reconcileAuthorization(attempt: PendingAuthorization,
  connection: Pick<Connection, 'getSignatureStatuses' | 'isBlockhashValid'>): Promise<AuthorizationOutcome> {
  if (!attempt.signature) return 'RETRY_SAFE' // This client never submits without persisting the signature.
  const status = (await connection.getSignatureStatuses([attempt.signature], { searchTransactionHistory: true })).value[0]
  if (status) return outcome(status)
  if (!attempt.blockhash) return 'UNKNOWN' // Legacy record: insufficient evidence; preserve it.
  if ((await connection.isBlockhashValid(attempt.blockhash, { commitment: 'finalized' })).value) return 'UNKNOWN'
  // Recheck history after expiry, closing the status/expiry observation race.
  const after = (await connection.getSignatureStatuses([attempt.signature], { searchTransactionHistory: true })).value[0]
  return after ? outcome(after) : 'RETRY_SAFE'
}

function outcome(status: { confirmationStatus?: string; err: unknown }): AuthorizationOutcome {
  if (status.err) return status.confirmationStatus === 'finalized' ? 'RETRY_SAFE' : 'UNKNOWN'
  return status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized' ? 'CONFIRMED' : 'UNKNOWN'
}

export type PurchaseContinuation = { discoveryId: string; candidateId: string; owner: string; maximumLamports: string; ceiling: string; state: 'authorized-request' | 'started' }
export function matchesPurchaseContinuation(saved: PurchaseContinuation, expected: Omit<PurchaseContinuation, 'state'>): boolean {
  return saved.state === 'authorized-request' && saved.discoveryId === expected.discoveryId
    && saved.candidateId === expected.candidateId && saved.owner === expected.owner
    && saved.maximumLamports === expected.maximumLamports && saved.ceiling === expected.ceiling
}
