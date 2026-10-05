import test from 'node:test'
import assert from 'node:assert/strict'
import { NFTIntentParser } from '../src/services/acquisition/discovery.js'
import { resolveConversationInput } from '../src/services/acquisition/NaConversationContext.js'

test('cheapest collection search does not invent spending authority', async () => {
  const parser = new NFTIntentParser()
  const intent = await parser.parse('Mua NFT rẻ nhất của collection y00ts')
  assert.equal(intent.collectionQuery, 'y00ts')
  assert.equal(intent.objective, 'LOWEST_PRICE')
  assert.equal(intent.priceDiscoveryOnly, true)
  assert.equal(intent.maxPriceSol, undefined)
  const reply = await resolveConversationInput('0.43 SOL', {
    currentPrompt: 'Mua NFT rẻ nhất của collection y00ts', currentIntent: intent,
    previousMints: [], messages: [],
  }, parser)
  assert.ok(!('error' in reply))
  assert.equal(reply.intent.collectionQuery, 'y00ts')
  assert.equal(reply.intent.maximumLamports, '430000000')
  assert.equal(reply.intent.priceDiscoveryOnly, false)
  assert.equal(reply.intent.action, 'SEARCH')
  const next = await resolveConversationInput('Mua NFT rẻ nhất collection Mad Lads', {
    currentPrompt: 'y00ts under 0.43 SOL', currentIntent: reply.intent, previousMints: [], messages: [],
  }, parser)
  assert.ok(!('error' in next))
  assert.equal(next.intent.priceDiscoveryOnly, true)
  assert.equal(next.intent.maxPriceSol, undefined)
})

test('named collection research needs no budget but never grants spending authority', async () => {
  const parser = new NFTIntentParser()
  await assert.rejects(parser.parse('Mua NFT'))
  assert.equal((await parser.parse('Mua NFT collection y00ts')).priceDiscoveryOnly, true)
  const intent = await parser.parse('Buy cheapest NFT collection y00ts under 1 SOL')
  assert.equal(intent.priceDiscoveryOnly, undefined)
  assert.equal(intent.maximumLamports, '999999999')
})
