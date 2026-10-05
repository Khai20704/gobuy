import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { naChatKind } from '@gobuy/shared'
import { NaChatService } from '../src/services/acquisition/NaChatService.js'
import { AcquisitionService } from '../src/services/acquisition/AcquisitionService.js'
import { DiscoveryEngine, NFTIntentParser } from '../src/services/acquisition/discovery.js'
import { FileAssetStore } from '../src/persistence/AssetStore.js'
import { ProviderRequestError } from '../src/services/search/http.js'
import { Keypair } from '@solana/web3.js'

test('questions and ambiguous ranking do not enter the purchase flow', () => {
  assert.equal(naChatKind('Na ơi'), 'greeting')
  assert.equal(naChatKind('NFT là gì?'), 'question')
  assert.equal(naChatKind('sao hỏi gì cũng không trả lời vậy?', true), 'explanation')
  assert.equal(naChatKind('Mua cho mình tranh nft đang đứng số 1, dưới 1 SOL'), undefined)
  assert.equal(naChatKind('NFT đáng mua nhất trong collection Retardio_Cousins dưới 1 SOL'), undefined)
  for (const text of ['Mua NFT mèo dưới 1 SOL', 'Tìm NFT hiếm nhất dưới 1 SOL', 'Chỉ tìm NFT đứng số 1 về lượt mua nhiều nhất dưới 1 SOL']) {
    assert.equal(naChatKind(text), undefined)
  }
  assert.equal(naChatKind('thử lại', true), undefined)
  assert.equal(naChatKind('More rare', true), undefined)
  assert.equal(naChatKind('Tại sao NFT này đắt?', true), 'question')
  assert.equal(naChatKind('còn cái này thì sao?', true), 'question')
})

test('chat remains useful offline and remembers only the same user conversation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'na-chat-'))
  let received: string[] = []
  const service = new NaChatService({ isConfigured: () => true, generate: async request => {
    received = request.messages.map(item => item.content)
    throw new Error('private API failure')
  } }, new FileAssetStore(root))
  const first = await service.reply('alice', 'NFT là gì?', 'thread')
  assert.equal(first.mode, 'local')
  assert.match(first.message, /định danh riêng/)
  const second = await service.reply('alice', 'Floor price là gì?', 'thread')
  assert.ok(received.includes('NFT là gì?'))
  assert.match(second.message, /giá chào bán thấp nhất/)
  assert.doesNotMatch(second.message, /private API/)
  await service.reply('bob', 'Floor price là gì?', 'thread')
  assert.equal(received.length, 1)
  const ranking = await service.reply('alice', 'Mua NFT đứng số 1 dưới 1 SOL')
  assert.equal(ranking.kind, 'question')
  assert.doesNotMatch(ranking.message, /tiêu chí nào/)
})

test('Devnet explanation distinguishes Tensor purchases from simulations and requires Phantom approval', async () => {
  const reply = await new NaChatService().reply('alice', 'GoBuy dùng Devnet như thế nào?')
  assert.match(reply.message, /Tensor Marketplace Program/)
  assert.match(reply.message, /Phantom/)
  assert.doesNotMatch(reply.message, /đang mô phỏng/)
})

test('marketplace rate limiting explains recovery and retry keeps collection and budget without buying', async () => {
  const root = await mkdtemp(join(tmpdir(), 'na-retry-'))
  const provider = { name: 'Magic Eden', search: async () => { throw new ProviderRequestError(429) }, refresh: async () => undefined }
  const service = new AcquisitionService(new DiscoveryEngine([provider]), new NFTIntentParser(), undefined, undefined,
    new FileAssetStore(join(root, 'discoveries')), undefined, undefined, undefined, new FileAssetStore(join(root, 'conversations')))
  const reply = await service.discover('alice', 'Mua NFT trong collection Retardio_Cousins dưới 1 SOL', undefined, 'thread')
  assert.equal(reply.status, 'DATA_UNAVAILABLE')
  assert.match(reply.message, /giới hạn lượt truy cập/)
  assert.match(reply.message, /Retardio_Cousins/i)
  const retry = await service.discover('alice', 'thử lại', undefined, 'thread')
  assert.equal(retry.intent.collectionQuery, reply.intent.collectionQuery)
  assert.equal(retry.intent.maximumLamports, reply.intent.maximumLamports)
  assert.equal(retry.intent.action, 'SEARCH')
})

test('a successful empty marketplace is not described as an outage just because it returns a warning', async () => {
  const root = await mkdtemp(join(tmpdir(), 'na-empty-'))
  const provider = { name: 'Magic Eden', search: async () => ({ candidates: [], warnings: ['No listing in budget'] }), refresh: async () => undefined }
  const service = new AcquisitionService(new DiscoveryEngine([provider]), new NFTIntentParser(), undefined, undefined, new FileAssetStore(root))
  const reply = await service.discover('alice', 'Tìm NFT mèo dưới 1 SOL')
  assert.equal(reply.status, 'NO_MATCH')
  assert.match(reply.message, /Chưa tìm thấy listing/)
  assert.doesNotMatch(reply.message, /chưa kết nối|chưa sẵn sàng/)
})
