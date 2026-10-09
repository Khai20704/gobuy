import assert from 'node:assert/strict'
import { test } from 'node:test'
import { classifyAssetIntent, isGenericNFTRequest } from '../src/services/rwa/classification.js'
test('generic NFT requests never access registry', async () => {
  for (const text of ['Buy any nft under 1 SOL', 'Mua NFT dưới 0.5 SOL']) {
    const reply = await classifyAssetIntent(text, () => false, async () => { assert.fail('Registry accessed') })
    assert.equal(reply.assetType, 'NFT')
  }
})
test('mixed and named requests never bypass approved identity resolution', () => {
  for (const text of ['Buy NFT NVDAx under 1 SOL', 'Buy any nft under 1 SOL and RWA', 'NFT NVIDIA', 'buy NVDAx', 'Buy any nft under 1 SOL ethereum:0x' + 'a'.repeat(40)]) {
    assert.equal(isGenericNFTRequest(text), false)
  }
})
