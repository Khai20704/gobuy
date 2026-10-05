import assert from 'node:assert/strict'
import { test } from 'node:test'
import { JupiterClient } from '../src/services/jupiter/JupiterClient.js'
import { JupiterQuoteService } from '../src/services/jupiter/JupiterQuoteService.js'
import { jupiterOrderSchema, SOL_MINT, USDC_MINT } from '../src/services/jupiter/types.js'

const order = (overrides: Record<string, unknown> = {}) => ({
  inputMint: SOL_MINT,
  outputMint: USDC_MINT,
  inAmount: '100000000',
  outAmount: '1000000',
  otherAmountThreshold: '990000',
  slippageBps: 100,
  swapMode: 'ExactIn',
  transaction: null,
  requestId: 'request-1',
  lastValidBlockHeight: '300000000',
  routePlan: [{ swapInfo: { label: 'Test router' } }],
  ...overrides,
})

test('Jupiter V2 order accepts documented string block heights and validates strict quote bounds', async () => {
  const service = new JupiterQuoteService({
    request: async () => order(),
  } as unknown as JupiterClient)
  const result = await service.quote(SOL_MINT, USDC_MINT, '100000000')
  assert.equal(result.lastValidBlockHeight, '300000000')
  await assert.rejects(new JupiterQuoteService({
    request: async () => order({ otherAmountThreshold: '980000' }),
  } as unknown as JupiterClient).quote(SOL_MINT, USDC_MINT, '100000000'), /Quote Jupiter sai/)
  assert.equal(jupiterOrderSchema.safeParse(order({ lastValidBlockHeight: 300000000 })).success, true)
})

test('Jupiter client uses V2 API key, execute body, and explicit safe rate-limit failures', async () => {
  let requestUrl = '', requestInit: RequestInit | undefined
  const client = new JupiterClient('test-key', async (url, init) => {
    requestUrl = String(url); requestInit = init
    return Response.json({ status: 'Success', signature: 'signature', code: 0 })
  })
  await client.request('order', { inputMint: SOL_MINT, outputMint: USDC_MINT, amount: '1' })
  assert.match(requestUrl, /^https:\/\/api\.jup\.ag\/swap\/v2\/order\?/)
  assert.equal((requestInit?.headers as Record<string, string>)['x-api-key'], 'test-key')
  await client.request('execute', { requestId: 'request-1', signedTransaction: 'signed' })
  assert.equal(requestUrl, 'https://api.jup.ag/swap/v2/execute')
  assert.equal(requestInit?.body, JSON.stringify({ requestId: 'request-1', signedTransaction: 'signed' }))
  const limited = new JupiterClient('test-key', async () => new Response('', { status: 429 }))
  await assert.rejects(limited.request('order', {}), /Jupiter đang giới hạn lượt truy cập/)
})
