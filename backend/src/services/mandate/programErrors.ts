import { MANDATE_REJECTIONS, explainMandateRejection, formatSol, mandateRejectionFromProgramError, type MandateRejection } from '@gobuy/shared'

/**
 * Turns a failed Solana transaction into the mandate vocabulary.
 *
 * The point of this module is that an on-chain rejection must never be presented as a wallet or
 * connection problem. Reconnecting Phantom cannot fix `BudgetExceeded`, so the UI must be told
 * exactly which rule refused the spend.
 */

/** Anchor prints the symbolic name in the program log: "Error Code: BudgetExceeded". */
const ERROR_CODE_PATTERN = /Error Code:\s*([A-Za-z]+)/
/** Older runtimes only print the numeric custom code: "custom program error: 0x1773". */
const CUSTOM_CODE_PATTERN = /custom program error:\s*0x([0-9a-fA-F]+)/

export function rejectionFromLogs(logs: readonly string[] | null | undefined): MandateRejection | undefined {
  if (!logs) return undefined
  for (const line of logs) {
    const named = ERROR_CODE_PATTERN.exec(line)?.[1]
    if (named && (MANDATE_REJECTIONS as readonly string[]).includes(named)) return named as MandateRejection
    const hex = CUSTOM_CODE_PATTERN.exec(line)?.[1]
    if (hex) {
      const mapped = mandateRejectionFromProgramError(Number.parseInt(hex, 16))
      if (mapped) return mapped
    }
  }
  return undefined
}

/** Logs can arrive on the error object (preflight) or only through `getLogs()`. */
function logsOf(error: unknown): readonly string[] | undefined {
  if (!error || typeof error !== 'object') return undefined
  const logs = (error as { logs?: unknown }).logs
  return Array.isArray(logs) ? logs.filter((line): line is string => typeof line === 'string') : undefined
}

/**
 * Readable message for a rejected or failed Na Vault transaction. Falls back to a generic
 * Devnet message that never blames the wallet.
 */
export function explainTransactionFailure(error: unknown, context: { amountLamports?: bigint; remainingLamports?: bigint } = {}): string {
  const rejection = rejectionFromLogs(logsOf(error))
  if (rejection) return explainMandateRejection(rejection, context)
  return 'Giao dịch Na Vault không hoàn tất trên Solana Devnet. Không có khoản chi nào được ghi nhận.'
}

/** Used by the API to expose the structured reason alongside the readable message. */
export function rejectionCodeOf(error: unknown): MandateRejection | undefined {
  return rejectionFromLogs(logsOf(error))
}

export { formatSol }
