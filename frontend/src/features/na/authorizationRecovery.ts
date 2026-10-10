import type { Connection } from '@solana/web3.js'

export type PendingAuthorization = { signature?: string; blockhash?: string; createdAt?: number }

// Absence of a status alone is not evidence of failure. All reads must succeed.
export async function authorizationRetrySafe(attempt: PendingAuthorization,
  connection: Pick<Connection, 'getSignatureStatuses' | 'isBlockhashValid'>): Promise<boolean> {
  if (!attempt.signature) return true // This client never submits without persisting the signature.
  const status = (await connection.getSignatureStatuses([attempt.signature], { searchTransactionHistory: true })).value[0]
  if (status) return status.confirmationStatus === 'finalized' && !!status.err
  if (!attempt.blockhash) return false // Legacy record: insufficient evidence; preserve it.
  if ((await connection.isBlockhashValid(attempt.blockhash, { commitment: 'finalized' })).value) return false
  // Recheck history after expiry, closing the status/expiry observation race.
  const after = (await connection.getSignatureStatuses([attempt.signature], { searchTransactionHistory: true })).value[0]
  return !after || after.confirmationStatus === 'finalized' && !!after.err
}

export type PurchaseContinuation = { discoveryId: string; candidateId: string; owner: string; maximumLamports: string; ceiling: string; state: 'authorized-request' | 'started' }
export function matchesPurchaseContinuation(saved: PurchaseContinuation, expected: Omit<PurchaseContinuation, 'state'>): boolean {
  return saved.state === 'authorized-request' && saved.discoveryId === expected.discoveryId
    && saved.candidateId === expected.candidateId && saved.owner === expected.owner
    && saved.maximumLamports === expected.maximumLamports && saved.ceiling === expected.ceiling
}
