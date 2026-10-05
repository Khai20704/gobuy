import { nftMarketFeaturesSchema, type NFTCandidate, type NFTMarketFeatures } from '@gobuy/shared'
import { z } from 'zod'

const activity = z.object({ signature: z.string(), type: z.string(), blockTime: z.number().int(),
  tokenMint: z.string().optional(), mint: z.string().optional(),
  price: z.number().finite().nonnegative().optional(), buyer: z.string().optional(), seller: z.string().optional() })
export const changePercent = (current?: number, previous?: number) => current !== undefined && previous !== undefined && previous > 0
  ? (current - previous) / previous * 100 : undefined

export function normalizeFeatures(candidate: NFTCandidate, raw: unknown[], completeHistory: boolean,
  rawStats: unknown = {}, now = Date.now()): NFTMarketFeatures {
  const stats = z.object({ listedCount: z.number().int().nonnegative().optional(),
    totalSupply: z.number().int().positive().optional(), volume7dSol: z.number().finite().nonnegative().optional() }).safeParse(rawStats)
  const parsedRows = raw.map(row => activity.safeParse(row))
  const schemaRejected = parsedRows.filter(row => !row.success).length
  if (schemaRejected) console.info('[NFT Features]', JSON.stringify({ event: 'activity_schema', received: raw.length, schemaRejected }))
  if (!stats.success) console.info('[NFT Features]', JSON.stringify({ event: 'stats_schema', outcome: 'invalid' }))
  const rows = parsedRows.flatMap(parsed => parsed.success ? [parsed.data] : [])
    .filter((row, index, all) => all.findIndex(other => other.signature === row.signature) === index)
    .filter(row => row.blockTime * 1000 <= now)
  const sales = rows.filter(row => ['buyNow', 'acceptBid', 'buy', 'sale'].includes(row.type) && row.price !== undefined)
  const mintSales = candidate.mint ? sales.filter(row => (row.tokenMint ?? row.mint) === candidate.mint) : []
  const mintHistoryComplete = completeHistory && rows.filter(row =>
    ['buyNow', 'acceptBid', 'buy', 'sale'].includes(row.type)).every(row =>
    !!(row.tokenMint ?? row.mint) && row.price !== undefined)
  const covered = (_hours: number) => schemaRejected === 0 && completeHistory
  const period = (hours: number, previous = false) => sales.filter(row => {
    const age = now - row.blockTime * 1000
    return age >= (previous ? hours * 3600000 : 0) && age < hours * 3600000 * (previous ? 2 : 1)
  })
  const metrics: Record<string, number | undefined> = {}
  for (const [label, hours] of [['1h', 1], ['24h', 24], ['7d', 168]] as const) {
    if (!covered(hours)) continue
    const current = period(hours), previous = period(hours, true)
    const volume = (items: typeof sales) => items.reduce((sum, item) => sum + item.price!, 0)
    const buyers = (items: typeof sales) => items.every(item => item.buyer) ? new Set(items.map(item => item.buyer)).size : undefined
    metrics[`volume${label}`] = volume(current); metrics[`sales${label}`] = current.length
    if (covered(hours * 2)) {
      metrics[`volumeChange${label}`] = changePercent(volume(current), volume(previous))
      metrics[`salesChange${label}`] = changePercent(current.length, previous.length)
      metrics[`buyerChange${label}`] = changePercent(buyers(current), buyers(previous))
    }
  }
  const day = period(24), bothParties = day.length > 0 && day.every(row => row.buyer && row.seller)
  const listedCount = stats.success ? stats.data.listedCount : undefined
  const supply = stats.success ? stats.data.totalSupply : undefined
  const dailySales = metrics.sales24h
  const liquidityScore = dailySales === undefined ? undefined : Math.min(100, Math.log10(1 + dailySales) * 40)
  const mintSalesFor = (hours: number) => covered(hours) && mintHistoryComplete && candidate.mint
    ? period(hours).filter(row => (row.tokenMint ?? row.mint) === candidate.mint) : undefined
  const mintSales1h = mintSalesFor(1), dailyMintSales = mintSalesFor(24), mintSales7d = mintSalesFor(168)
  const mintBuyers = dailyMintSales?.every(row => row.buyer) ? new Set(dailyMintSales.map(row => row.buyer)).size : undefined
  return nftMarketFeaturesSchema.parse({ mint: candidate.mint ?? candidate.id, collection: candidate.collection,
    priceSol: Number(candidate.listing.priceLamports) / 1e9,
    marketScope: dailyMintSales === undefined ? 'collection' : 'mint',
    mintSales1h: mintSales1h?.length, mintSales24h: dailyMintSales?.length, mintSales7d: mintSales7d?.length,
    mintUniqueBuyers24h: mintBuyers,
    mintVolume24h: dailyMintSales?.reduce((sum, row) => sum + row.price!, 0),
    floorPriceSol: candidate.marketData?.collectionFloorLamports ? Number(candidate.marketData.collectionFloorLamports) / 1e9 : undefined,
    ...metrics, volume7d: stats.success ? stats.data.volume7dSol ?? metrics.volume7d : metrics.volume7d,
    listedCount, supply, listedRatio: supply && listedCount !== undefined ? Math.min(1, listedCount / supply) : undefined,
    uniqueBuyers24h: covered(24) && bothParties ? new Set(day.map(row => row.buyer)).size : undefined,
    uniqueSellers24h: covered(24) && bothParties ? new Set(day.map(row => row.seller)).size : undefined,
    selfTradeRatio: bothParties ? day.filter(row => row.buyer === row.seller).length / day.length : undefined,
    topSellerShare: bothParties ? Math.max(...day.map(row => day.filter(other => other.seller === row.seller).length)) / day.length : undefined,
    liquidityScore, observations: dailyMintSales === undefined ? sales.length : mintSales.length,
    coverage: covered(48) ? 'complete' : 'partial',
    source: candidate.provider, observedAt: new Date(now).toISOString(),
    warnings: [...candidate.warnings,
      ...(covered(48) ? [] : ['Lịch sử giao dịch bị giới hạn; các chỉ số thiếu cửa sổ đầy đủ được để trống.'])],
  })
}

export function addMarketHistory(features: NFTMarketFeatures, history: NFTMarketFeatures[]): NFTMarketFeatures {
  const result = { ...features }
  for (const [label, hours] of [['1h', 1], ['24h', 24], ['7d', 168]] as const) {
    const target = Date.parse(features.observedAt) - hours * 3600000
    const prior = history.filter(row => row.collection === features.collection && row.source === features.source
      && Math.abs(Date.parse(row.observedAt) - target) <= hours * 3600000 * 0.1)
      .sort((a, b) => Math.abs(Date.parse(a.observedAt) - target) - Math.abs(Date.parse(b.observedAt) - target))[0]
    result[`floorChange${label}`] = changePercent(features.floorPriceSol, prior?.floorPriceSol)
    if (label === '7d') result.volumeChange7d = changePercent(features.volume7d, prior?.volume7d)
  }
  return result
}
