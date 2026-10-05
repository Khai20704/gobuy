import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Keypair } from '@solana/web3.js'
import { NFTIntentParser } from '../src/services/acquisition/discovery.js'
import { resolveConversationInput, type NaConversationState } from '../src/services/acquisition/NaConversationContext.js'
import { FileAssetStore } from '../src/persistence/AssetStore.js'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const parser = new NFTIntentParser()

async function state(): Promise<NaConversationState> {
  const intent = await parser.parse('Find me a dark NFT under 1 SOL')
  return {
    currentPrompt: 'Find me a dark NFT under 1 SOL',
    currentIntent: intent,
    selectedCandidate: {
      id: 'selected', provider: 'Magic Eden', sourceNetwork: 'mainnet', mint: Keypair.generate().publicKey.toBase58(),
      name: 'Dark Panda', description: 'dark background', image: null, collection: 'Pandas', attributes: [],
      listing: { priceLamports: '700000000', currency: 'SOL', seller: Keypair.generate().publicKey.toBase58(),
        url: '', observedAt: new Date().toISOString() },
      relevance: 1, reasons: [], warnings: [],
    },
    previousMints: [],
    messages: [],
  }
}

test('contextual feedback reuses the server-stored search and excludes the selected mint', async () => {
  const prior = await state()
  const moreRare = await resolveConversationInput('More rare.', prior, parser)
  assert.ok('intent' in moreRare)
  assert.equal(moreRare.contextual, true)
  assert.equal(moreRare.prompt, prior.currentPrompt)
  assert.deepEqual(moreRare.intent.priorities, ['rarity'])
  assert.ok(moreRare.intent.excludedMints.includes(prior.selectedCandidate!.mint!))

  const colorful = await resolveConversationInput('Too colorful.', prior, parser)
  assert.ok('intent' in colorful)
  assert.ok(colorful.intent.avoidTerms.includes('colorful'))
  assert.ok(colorful.intent.excludedMints.includes(prior.selectedCandidate!.mint!))

  const another = await resolveConversationInput('Find another.', prior, parser)
  assert.ok('intent' in another)
  assert.ok(another.intent.excludedMints.includes(prior.selectedCandidate!.mint!))

  const anotherVietnamese = await resolveConversationInput('Tìm cái khác.', prior, parser)
  assert.ok('intent' in anotherVietnamese)
  assert.ok(anotherVietnamese.intent.excludedMints.includes(prior.selectedCandidate!.mint!))

  const darker = await resolveConversationInput('Tối hơn.', prior, parser)
  assert.ok('intent' in darker)
  assert.ok(darker.intent.terms.includes('dark'))
})

test('cheaper and budget follow-ups lower the existing budget without losing subject', async () => {
  const prior = await state()
  const cheaper = await resolveConversationInput('Cheaper.', prior, parser)
  assert.ok('intent' in cheaper)
  assert.equal(cheaper.intent.maximumLamports, '699999999')
  assert.ok(cheaper.intent.terms.includes('dark'))

  const budget = await resolveConversationInput('Actually max 0.5 SOL.', prior, parser)
  assert.ok('intent' in budget)
  assert.equal(budget.intent.maximumLamports, '500000000')
  assert.ok(budget.intent.terms.includes('dark'))
})

test('conversation context persists by account in the configured asset store', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'na-conversations-'))
  const store = new FileAssetStore<NaConversationState>(directory)
  const saved = await state()
  await store.put('alice', 'conversation-id', saved)
  const reloaded = await store.get('alice', 'conversation-id')
  assert.deepEqual(reloaded, JSON.parse(JSON.stringify(saved)))
  assert.equal(await store.get('bob', 'conversation-id'), undefined)
})
