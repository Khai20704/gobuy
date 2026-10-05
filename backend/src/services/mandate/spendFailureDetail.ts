/** Preserve RPC/Anchor diagnostics without returning authenticated URLs or credential values. */
export function spendFailureDetail(error: unknown): string {
  const value = error && typeof error === 'object' ? error as { message?: unknown; logs?: unknown } : {}
  const logs = Array.isArray(value.logs) ? value.logs.filter((line): line is string => typeof line === 'string'
    && /Error Code:|custom program error:|Program \w+ failed:/.test(line)) : []
  const detail = logs.length ? logs.join('\n') : typeof value.message === 'string' ? value.message : 'RPC/Anchor transaction failure'
  return detail.replace(/https?:\/\/[^\s"'<>]+/gi, '[RPC URL redacted]')
    .replace(/((?:api[-_ ]?key|authorization|token|secret|private[-_ ]?key)\s*[:=]\s*)[^\s,;]+/gi, '$1[redacted]')
    .slice(0, 1500)
}
