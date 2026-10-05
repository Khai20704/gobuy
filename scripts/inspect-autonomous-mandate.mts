// Read-only Devnet check. Never signs, broadcasts, or prints secret configuration.
import { requiredMandateClient } from '../backend/src/services/mandate/MandateProgramClient.js'
import { serializeMandate } from '../backend/src/services/mandate/MandateGuard.js'

try {
  const owner = process.argv[2]
  if (!owner) throw new Error('Public owner address required')
  const client = requiredMandateClient()
  const mandate = await client.read(owner)
  console.log(JSON.stringify({ owner, mandate: serializeMandate(mandate),
    configuredExecutorMatches: !!mandate && client.agent?.publicKey.toBase58() === mandate.executor,
    configuredSettlementMatches: !!mandate && client.settlement?.toBase58() === mandate.recipient,
  }, null, 2))
} catch (error) {
  console.error('Read-only Devnet inspection failed:', error instanceof Error ? error.name : 'Unknown error')
  process.exitCode = 1
}
