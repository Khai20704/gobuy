import assert from 'node:assert/strict'
import { test } from 'node:test'
import { solanaConfig, assertDevnet, DEVNET_GENESIS } from '../src/solanaNetwork.js'

test('RPC identity uses the full Devnet genesis hash, not the truncated CAIP chain reference', async () => {
  // Independent RPC fixture: do not derive the accepted value from DEVNET_GENESIS.
  const rpcResult = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG'
  assert.equal(DEVNET_GENESIS, rpcResult)
  await assertDevnet({ getGenesisHash: async () => rpcResult }, solanaConfig())
  await assert.rejects(assertDevnet({ getGenesisHash: async () => 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1' }, solanaConfig()), /different genesis hash/)
})

test('configuration fails closed for all unsupported networks and conflicting legacy overrides', () => {
  assert.equal(solanaConfig().network, 'devnet')
  for (const network of ['mainnet-beta', 'mainnet', 'testnet', '', 'localnet']) {
    assert.throws(() => solanaConfig({ SOLANA_NETWORK: network }), /Mainnet transactions are disabled/)
  }
  for (const key of ['NFT_DEMO_RPC_URL', 'SOLANA_DEVNET_RPC_URL', 'VITE_SOLANA_RPC_URL']) {
    assert.throws(() => solanaConfig({ [key]: 'https://wrong.invalid' }), /Conflicting/)
  }
  assert.throws(() => solanaConfig({ SOLANA_RPC_URL: 'https://mainnet.invalid' }))
})
test('custom RPC must prove Devnet identity; failures never fall back', async () => {
  const config = solanaConfig({ SOLANA_RPC_URL: 'https://custom.invalid' })
  await assertDevnet({ getGenesisHash: async () => DEVNET_GENESIS }, config)
  await assert.rejects(assertDevnet({ getGenesisHash: async () => 'wrong' }, config))
  await assert.rejects(assertDevnet({ getGenesisHash: async () => { throw new Error('offline') } }, config), /offline/)
})
