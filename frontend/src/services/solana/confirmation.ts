export interface ConfirmationConnection {
  confirmTransaction(strategy: { signature: string; blockhash: string; lastValidBlockHeight: number }, commitment: 'confirmed'):
    Promise<{ value: { err: unknown } }>
}
export class UnconfirmedTransactionError extends Error {
  constructor(public readonly signature: string) {
    super('No verified result yet. Transaction submitted, but confirmation or audit loading failed. Refresh activity before retrying.')
  }
}
export async function requireConfirmation(connection: ConfirmationConnection, signature: string, block: { blockhash: string; lastValidBlockHeight: number }) {
  try {
    const confirmation = await connection.confirmTransaction({ signature, ...block }, 'confirmed')
    if (confirmation.value.err) throw new Error('Transaction failed')
  } catch { throw new UnconfirmedTransactionError(signature) }
}
