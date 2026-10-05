export type MongoFailure = 'TLS_HANDSHAKE_FAILED' | 'DNS_FAILED' | 'AUTH_FAILED' | 'ACCESS_DENIED'
  | 'INDEX_CONFLICT' | 'NETWORK_FAILED' | 'SERVER_SELECTION_TIMEOUT' | 'UNKNOWN'

// Only emit fixed categories/hints, never raw driver messages: they can contain URI credentials.
export function diagnoseMongoFailure(error: unknown): { category: MongoFailure; hint: string } {
  const names = new Set<unknown>(), codes = new Set<unknown>(), seen = new Set<unknown>()
  function visit(value: unknown, depth = 0) {
    if (!value || typeof value !== 'object' || seen.has(value) || depth > 8) return
    seen.add(value)
    const item = value as Record<string, unknown>
    names.add(item.name); codes.add(item.code)
    visit(item.cause, depth + 1); visit(item.reason, depth + 1); visit(item.error, depth + 1)
    if (item.servers instanceof Map) for (const server of item.servers.values()) visit(server, depth + 1)
  }
  visit(error)
  let category: MongoFailure = 'UNKNOWN'
  if (codes.has(18)) category = 'AUTH_FAILED'
  else if (codes.has(13)) category = 'ACCESS_DENIED'
  else if ([85, 86, 11000].some(code => codes.has(code))) category = 'INDEX_CONFLICT'
  else if ([...codes].some(code => typeof code === 'string' && /^(ERR_SSL_|ERR_TLS_|CERT_|DEPTH_ZERO_SELF_SIGNED_CERT|UNABLE_TO_VERIFY_LEAF_SIGNATURE)/.test(code))) category = 'TLS_HANDSHAKE_FAILED'
  else if (['ENOTFOUND', 'EAI_AGAIN', 'ESERVFAIL', 'ENODATA'].some(code => codes.has(code))) category = 'DNS_FAILED'
  else if (['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EACCES'].some(code => codes.has(code))) category = 'NETWORK_FAILED'
  else if (names.has('MongoServerSelectionError')) category = 'SERVER_SELECTION_TIMEOUT'
  const hints: Record<MongoFailure, string> = {
    TLS_HANDSHAKE_FAILED: 'TLS failed before authentication. Check Atlas IP Access List for the current outbound IP, cluster availability, VPN and TLS inspection. Keep certificate verification enabled.',
    DNS_FAILED: 'Cannot resolve MongoDB hosts. Check DNS and the cluster hostname in backend/.env.',
    AUTH_FAILED: 'Database authentication failed. Check the database user, password encoding and authSource in backend/.env.',
    ACCESS_DENIED: 'The database user lacks permission for this operation. Check privileges for the configured database.',
    INDEX_CONFLICT: 'Index initialization failed. Inspect existing index definitions or duplicate keys; do not delete data automatically.',
    NETWORK_FAILED: 'Cannot reach the MongoDB servers reliably. Check port 27017, firewall/VPN and Atlas IP Access List.',
    SERVER_SELECTION_TIMEOUT: 'No usable MongoDB server was selected. Check cluster availability, Atlas IP Access List and network connectivity.',
    UNKNOWN: 'Check backend MongoDB configuration and cluster availability. Raw driver errors are intentionally not logged.',
  }
  return { category, hint: hints[category] }
}
