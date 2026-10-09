import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PublicKey, type Connection } from '@solana/web3.js'
import { XStocksSync, mergeIssuerAssets } from '../src/services/rwa/XStocksSync.js'
import { MAINNET_GENESIS, RWARegistry, RWA_REGISTRY_CAPACITY } from '../src/services/rwa/RWARegistry.js'
import { rankApprovedCandidates } from '../src/services/rwa/RWARecommendation.js'

const mint = 'So11111111111111111111111111111111111111112'
const mapping = { networkField: 'network', mintField: 'address', solanaNetwork: 'Solana' }
const node = { symbol: 'TESTx', name: 'Issuer test equity', underlying: { symbol: 'TEST', type: 'Equity' },
  isTradingHalted: false, sector: 'Technology', deployments: [{ network: 'Solana', address: mint }] }
const rpc = { getGenesisHash: async () => MAINNET_GENESIS, getParsedAccountInfo: async () => ({ value: {
  owner: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
  data: { parsed: { type: 'mint', info: { decimals: 8, isInitialized: true } } },
} }) } as unknown as Connection
const page = (nodes: unknown[], currentPage = 0, hasNextPage = false) => ({ nodes, page: { currentPage, hasNextPage } })
const loader = (response: unknown, chain = rpc) => new XStocksSync(mapping, (async () => Response.json(response)) as typeof fetch, chain, async () => {})

test('multi-chain sync and registry retain more than 5000 deployments without truncation', async () => {
  const nodes = Array.from({ length: 834 }, (_, i) => ({ ...node, symbol: `T${i}x`, deployments:
    ['Ethereum', 'Base', 'Arbitrum', 'Polygon', 'Gnosis', 'Avalanche'].map(network => ({ network,
      address: '0x' + (i + 1).toString(16).padStart(40, '0') })) }))
  const progress: number[] = []
  const sync = new XStocksSync(mapping, (async (url: string) => {
    const index = Number(new URL(url).searchParams.get('page'))
    return Response.json(page(nodes.slice(index * 100, (index + 1) * 100), index, (index + 1) * 100 < nodes.length))
  }) as typeof fetch, { getGenesisHash: async () => assert.fail('no Solana deployments') } as unknown as Connection,
  async () => {}, count => progress.push(count))
  const rows = await sync.collect()
  assert.equal(rows.length, 5004)
  assert.equal(new RWARegistry(rows, rpc).list().length, 5004)
  assert.equal(mergeIssuerAssets([], rows).length, 5004)
  assert.ok(progress.includes(5000))
})

test('issuer sync and registry accept more than 500 assets without truncation', async () => {
  const nodes = Array.from({ length: 501 }, (_, i) => ({ ...node, symbol: `T${i}x`, deployments: [
    { network: 'Solana', address: new PublicKey(Uint8Array.from({ length: 32 }, (_, j) => j === 30 ? i >> 8 : j === 31 ? i & 255 : 1)).toBase58() },
  ] }))
  const sync = new XStocksSync(mapping, (async (url: string) => {
    const index = Number(new URL(url).searchParams.get('page'))
    return Response.json(page(nodes.slice(index * 100, (index + 1) * 100), index, (index + 1) * 100 < nodes.length))
  }) as typeof fetch, rpc, async () => {})
  const rows = await sync.collect()
  assert.equal(rows.length, 501)
  assert.equal(new RWARegistry(rows, rpc).list().length, 501)
  assert.equal(mergeIssuerAssets([], rows).length, 501)
  assert.throws(() => mergeIssuerAssets(Array.from({ length: RWA_REGISTRY_CAPACITY + 1 }, () => rows[0]), []), /capacity/)
})

test('issuer pagination and on-chain identity checks collect assets without market judgments', async () => {
  const calls: string[] = []
  const sync = new XStocksSync(mapping, (async (url: string) => {
    calls.push(url)
    return Response.json(calls.length === 1 ? page([node], 0, true) : page([], 1))
  }) as typeof fetch, rpc, async () => {})
  const assets = await sync.collect()
  assert.equal(assets.length, 1); assert.equal(assets[0].mint, mint)
  assert.equal(assets[0].decimals, 8); assert.equal(assets[0].sector, 'Technology')
  assert.equal(assets[0].verified, true)
  assert.ok(calls.every(url => url.startsWith('https://api.xstocks.fi/api/v2/public/assets?')))
})

test('empty, malformed, duplicated, ambiguous and wrong-network evidence fail closed', async () => {
  for (const payload of [page([]), {}, page([node, node]), page([{ ...node, deployments: [{ chain: 'Solana', address: mint }] }]),
    page([{ ...node, deployments: [node.deployments[0], node.deployments[0]] }])]) {
    await assert.rejects(loader(payload).collect())
  }
  await assert.rejects(loader(page([node]), { ...rpc, getGenesisHash: async () => 'devnet' } as Connection).collect())
})

test('manual approvals, explicit revocations, sector and wallet restrictions survive issuer refresh', async () => {
  const [fresh] = await loader(page([node])).collect()
  const manual = { ...fresh, syncSource: undefined, name: 'Manual name' }
  assert.deepEqual(mergeIssuerAssets([manual], [fresh])[0], manual)
  const revoked = { ...fresh, verified: false, allowedForSwap: false, sector: 'Reviewed sector', eligibleWallets: [mint] }
  const merged = mergeIssuerAssets([revoked], [fresh])[0]
  assert.equal(merged.verified, false); assert.equal(merged.allowedForSwap, false)
  assert.equal(merged.sector, revoked.sector); assert.deepEqual(merged.eligibleWallets, [mint])
  assert.equal(mergeIssuerAssets([fresh], [])[0].verified, false)
})

test('a halted issuer asset is not swappable and no backing collateral grants no identity', async () => {
  const [halted] = await loader(page([{ ...node, isTradingHalted: true }])).collect()
  assert.equal(halted.allowedForSwap, false)
  await assert.rejects(loader(page([{ ...node, underlying: null }])).collect())
})

test('issuer nullable underlying type stays OTHER; stablecoin addresses never become the asset mint', async () => {
  const [evm, asset] = await loader(page([{ ...node, name: 'Sony xStock', symbol: 'SONYx', sector: undefined,
    underlying: { symbol: 'SONY', type: null }, deployments: [
      { network: 'Ethereum', address: '0x8c06d627b8d57792803e3caed36f7af2ad883b01' },
      { network: 'Solana', address: mint, stablecoins: [{ symbol: 'USDC', decimals: 6,
        address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' }] },
    ] }])).collect()
  assert.equal(asset.category, 'OTHER')
  assert.equal(evm.mint, 'ethereum:0x8c06d627b8d57792803e3caed36f7af2ad883b01')
  assert.equal(evm.decimals, undefined)
  assert.equal(asset.mint, mint)
  assert.equal(asset.decimals, 8) // read from mint account, not nested stablecoin decimals
  assert.equal(asset.sector, undefined)
})

test('issuer EVM-only catalog requires no Solana RPC and separates same address by chain', async () => {
  const address = '0x' + 'a'.repeat(40)
  const rows = await loader(page([{ ...node, deployments: [{ network: 'Ethereum', address }, { network: 'Base', address }] }]),
    { getGenesisHash: async () => assert.fail('no Solana RPC required') } as unknown as Connection).collect()
  assert.equal(rows.length, 2)
  assert.notEqual(rows[0].mint, rows[1].mint)
  assert.equal(new RWARegistry(rows).list().length, 2)
})

test('ranking does not reward cheap unit prices; better reported quote impact wins', async () => {
  const [asset] = await loader(page([node])).collect()
  const cheap = { asset: { ...asset, symbol: 'CHEAPx' }, priceUsd: 1, estimatedQuantity: '100', priceImpactPct: 3 }
  const costly = { asset: { ...asset, symbol: 'COSTLYx' }, priceUsd: 1000, estimatedQuantity: '0.1', priceImpactPct: 0.1 }
  assert.equal(rankApprovedCandidates([cheap, costly], { amount: 100, currency: 'USDC' })[0].symbol, 'COSTLYx')
  const equal = rankApprovedCandidates([{ ...cheap, priceImpactPct: undefined }, { ...costly, priceImpactPct: undefined }], { amount: 100, currency: 'USDC' })
  assert.equal(equal[0].score, equal[1].score)
})

test('RPC throttling retries with bounded backoff and returns a clear error without a partial list', async () => {
  const waits: number[] = []; let calls = 0
  const chain = { ...rpc, getParsedAccountInfo: async () => { calls++; throw new Error('429 Too Many Requests') } } as unknown as Connection
  const sync = new XStocksSync(mapping, (async () => Response.json(page([node]))) as typeof fetch,
    chain, async ms => { waits.push(ms) })
  await assert.rejects(sync.collect(), /sau 3 lần thử lại/)
  assert.equal(calls, 4)
  assert.deepEqual(waits.filter(ms => ms > 1000), [5000, 10000, 20000])
})

test('a transient 429 recovers; non-rate-limit errors are not retried', async () => {
  let calls = 0
  const chain = { ...rpc, getParsedAccountInfo: async (key: PublicKey) => {
    if (++calls === 1) throw new Error('429 Too Many Requests')
    return rpc.getParsedAccountInfo(key)
  } } as unknown as Connection
  assert.equal((await loader(page([node]), chain).collect()).length, 1)
  assert.equal(calls, 2)
  calls = 0
  chain.getParsedAccountInfo = async () => { calls++; throw new Error('Invalid mint response') }
  await assert.rejects(loader(page([node]), chain).collect(), /Invalid mint/)
  assert.equal(calls, 1)
})
