import assert from 'node:assert/strict'
import { test } from 'node:test'
import { diagnoseMongoFailure } from '../src/persistence/mongoDiagnostics.js'

test('nested topology TLS failure is diagnosed without leaking connection strings', () => {
  const secret = 'mongodb+srv://user:private-password@cluster.example.net'
  const error = { name: 'MongoServerSelectionError', message: secret, reason: { servers: new Map([
    ['node', { error: { name: 'MongoNetworkError', cause: { code: 'ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR', message: secret } } }],
  ]) } }
  const result = diagnoseMongoFailure(error)
  assert.equal(result.category, 'TLS_HANDSHAKE_FAILED')
  assert.doesNotMatch(JSON.stringify(result), /private-password|mongodb\+srv|cluster\.example/)
})
test('diagnostics distinguish authentication, index, DNS and connectivity failures and handle cycles', () => {
  for (const [error, category] of [
    [{ code: 18 }, 'AUTH_FAILED'], [{ code: 13 }, 'ACCESS_DENIED'], [{ code: 11000 }, 'INDEX_CONFLICT'],
    [{ cause: { code: 'ENOTFOUND' } }, 'DNS_FAILED'], [{ code: 'ECONNREFUSED' }, 'NETWORK_FAILED'],
    [{ name: 'MongoServerSelectionError' }, 'SERVER_SELECTION_TIMEOUT'], [new Error('secret'), 'UNKNOWN'],
  ] as const) assert.equal(diagnoseMongoFailure(error).category, category)
  const cycle: { cause?: unknown } = {}; cycle.cause = cycle
  assert.equal(diagnoseMongoFailure(cycle).category, 'UNKNOWN')
})
