import assert from 'node:assert/strict'
import { test } from 'node:test'
import { requireDevnet, DEVNET_GENESIS } from '../src/services/solana/network.ts'
import { explorerTx } from '../src/services/solana/links.ts'
test('only the real Devnet genesis hash is accepted', async () => {
  await requireDevnet({ getGenesisHash: async () => DEVNET_GENESIS })
  for (const hash of ['mainnet', 'testnet', '', 'local-validator']) {
    await assert.rejects(requireDevnet({ getGenesisHash: async () => hash }), /Only Solana Devnet/)
  }
  await assert.rejects(requireDevnet({ getGenesisHash: async () => { throw new Error('RPC down') } }))
})
test('Explorer links always select Devnet', () => {
  const link = new URL(explorerTx('signature/?cluster=mainnet'))
  assert.equal(link.searchParams.get('cluster'), 'devnet')
  assert.equal(link.hostname, 'explorer.solana.com')
})
