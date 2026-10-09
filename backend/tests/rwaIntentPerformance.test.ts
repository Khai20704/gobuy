import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { RWAAsset } from '@gobuy/shared'
import { isRWARequest } from '../src/services/rwa/RWAIntent.js'

test('NFT classification scans a large RWA registry once instead of once per asset', () => {
  let reads = 0
  const assets = Array.from({ length: 2000 }, (_, i) => ({
    get symbol() { reads++; return `ASSET${i}x` },
    name: `Example issuer stock ${i}`,
  })) as RWAAsset[]
  assert.equal(isRWARequest('Buy any nft under 1 SOL', assets), false)
  assert.ok(reads <= assets.length * 3, `Unexpected repeated registry scans: ${reads}`)
  assert.equal(isRWARequest('Buy ASSET123x under 1 SOL', assets), true)
  assert.equal(isRWARequest('Tìm RWA công nghệ', assets), true)
})
