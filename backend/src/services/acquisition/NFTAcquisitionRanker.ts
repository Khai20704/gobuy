import { z } from 'zod'
import type { AcquisitionRanking, NFTCandidate, NFTSearchIntent } from '@gobuy/shared'
import { NFTRiskAnalyzer } from '../nft-intelligence/NFTRiskAnalyzer.js'

export const acquisitionWeightsSchema = z.object({
  intentMatch: z.number().positive(),
  preferenceMatch: z.number().positive(),
  visualMatch: z.number().positive(),
  rarity: z.number().positive(),
  marketQuality: z.number().positive(),
  priceFit: z.number().positive(),
}).strict()

export const DEFAULT_ACQUISITION_WEIGHTS = {
  intentMatch: 0.3,
  preferenceMatch: 0.2,
  visualMatch: 0.15,
  rarity: 0.1,
  marketQuality: 0.15,
  priceFit: 0.1,
} as const

export function acquisitionRankingConfig(env: NodeJS.ProcessEnv = process.env) {
  const weights = acquisitionWeightsSchema.parse({
    intentMatch: Number(env.NFT_SCORE_WEIGHT_INTENT ?? DEFAULT_ACQUISITION_WEIGHTS.intentMatch),
    preferenceMatch: Number(env.NFT_SCORE_WEIGHT_PREFERENCE ?? DEFAULT_ACQUISITION_WEIGHTS.preferenceMatch),
    visualMatch: Number(env.NFT_SCORE_WEIGHT_VISUAL ?? DEFAULT_ACQUISITION_WEIGHTS.visualMatch),
    rarity: Number(env.NFT_SCORE_WEIGHT_RARITY ?? DEFAULT_ACQUISITION_WEIGHTS.rarity),
    marketQuality: Number(env.NFT_SCORE_WEIGHT_MARKET ?? DEFAULT_ACQUISITION_WEIGHTS.marketQuality),
    priceFit: Number(env.NFT_SCORE_WEIGHT_PRICE ?? DEFAULT_ACQUISITION_WEIGHTS.priceFit),
  })
  const total = Object.values(weights).reduce((sum, weight) => sum + weight, 0)
  if (Math.abs(total - 1) > 0.001) throw new Error('NFT acquisition score weights must total 1.')
  const minScore = z.coerce.number().min(0).max(100).default(55).parse(env.NFT_MIN_ACQUISITION_SCORE)
  const minConfidence = z.coerce.number().min(0).max(100).default(30).parse(env.NFT_MIN_ACQUISITION_CONFIDENCE)
  const minAutoBuyScore = z.coerce.number().min(0).max(100).default(65).parse(env.NFT_MIN_AUTO_BUY_SCORE)
  const minAutoBuyConfidence = z.coerce.number().min(0).max(100).default(55).parse(env.NFT_MIN_AUTO_BUY_CONFIDENCE)
  const maxAutoBuyRisk = z.coerce.number().min(0).max(100).default(45).parse(env.NFT_MAX_AUTO_BUY_RISK)
  return { weights, minScore, minConfidence, minAutoBuyScore, minAutoBuyConfidence, maxAutoBuyRisk }
}

export type RankedNFT = { candidate: NFTCandidate; ranking: AcquisitionRanking }
const bestOverallWeights = { activity: 0.25, liquidity: 0.2, priceAttractiveness: 0.2, momentum: 0.15, rarity: 0.1, riskQuality: 0.1 } as const
const clamp01 = (value: number) => Math.min(1, Math.max(0, value))
const momentumSignal = (features: NonNullable<NFTCandidate['marketFeatures']>) => {
  const changes = [features.volumeChange24h ?? features.volumeChange7d, features.floorChange24h, features.salesChange24h, features.buyerChange24h]
    .filter((value): value is number => value !== undefined)
  return changes.length ? changes.reduce((sum, value) => sum + clamp01(0.5 + value / 200), 0) / changes.length : null
}

export class NFTAcquisitionRanker {
  constructor(private readonly config = acquisitionRankingConfig()) {}

  rank(candidate: NFTCandidate, intent: NFTSearchIntent): RankedNFT {
    const price = BigInt(candidate.listing.priceLamports)
    const budget = BigInt(intent.maximumLamports)
    if (candidate.provider === 'tensor' && candidate.sourceNetwork === 'devnet') {
      const priceFit = budget > 0n ? clamp01(Number((budget - price) * 1_000_000n / budget) / 1_000_000) : 0
      const verified = candidate.asset?.owner === candidate.marketplaceListing?.listingId && candidate.asset?.mint === candidate.mint
        && candidate.marketplaceListing?.status === 'LISTED'
      const factors = [
        { name: 'metadata relevance', value: intent.broadSearch ? null : candidate.relevance, weight: 0.3 },
        { name: 'budget price fit', value: priceFit, weight: 0.3 },
        { name: 'rarity', value: candidate.rarityScore ?? null, weight: 0.2 },
        { name: 'ownership verification', value: verified ? 1 : null, weight: 0.1 },
        { name: 'listing freshness', value: candidate.marketplaceListing?.listedAt
          ? clamp01(1 - (Date.now() - Date.parse(candidate.marketplaceListing.listedAt)) / 86400000) : null, weight: 0.1 },
      ]
      const available = factors.filter((factor): factor is typeof factor & { value: number } => factor.value !== null)
      const weight = available.reduce((sum, factor) => sum + factor.weight, 0)
      const score = intent.objective === 'LOWEST_PRICE' ? priceFit
        : intent.objective === 'RARITY' ? candidate.rarityScore ?? 0
        : available.reduce((sum, factor) => sum + factor.value * factor.weight, 0) / (weight || 1)
      return { candidate, ranking: { score: Math.round(score * 100), confidence: Math.round(weight * 100),
        components: { intentMatch: intent.broadSearch ? null : candidate.relevance, preferenceMatch: null, visualMatch: null,
          rarity: candidate.rarityScore ?? null, marketQuality: verified ? 1 : null, priceFit },
        reasons: available.map(factor => factor.name + ': ' + Math.round(factor.value * 100) + '/100; weight ' + Math.round(factor.weight / weight * 100) + '%')
          .concat('Missing factors are omitted and weights redistributed; does not indicate popularity or investment value.') } }
    }
    if (intent.action === 'BUY' && intent.objective === 'BEST_OVERALL') {
      const features = candidate.marketFeatures
      const risk = features ? new NFTRiskAnalyzer().analyze(features).risk : null
      const floor = features?.floorPriceSol ?? (candidate.marketData?.collectionFloorLamports
        ? Number(candidate.marketData.collectionFloorLamports) / 1e9 : undefined)
      const priceSol = Number(candidate.listing.priceLamports) / 1e9
      const factors = {
        activity: features?.sales24h === undefined ? features?.volume24h === undefined
          ? features?.volume7d === undefined ? null : clamp01(Math.log1p(features.volume7d) / Math.log(101))
          : clamp01(Math.log1p(features.volume24h) / Math.log(101))
          : clamp01(Math.log1p(features.sales24h) / Math.log(101)),
        liquidity: features?.liquidityScore === undefined ? null : clamp01(features.liquidityScore / 100),
        priceAttractiveness: floor !== undefined && floor > 0 && priceSol > 0 ? clamp01(floor / priceSol) : null,
        momentum: features ? momentumSignal(features) : null,
        rarity: candidate.rarityScore ?? null,
        riskQuality: risk === null ? null : 1 - risk / 100,
        risk,
      }
      const availableWeight = Object.entries(bestOverallWeights).reduce((sum, [key, weight]) =>
        sum + (factors[key as keyof typeof bestOverallWeights] === null ? 0 : weight), 0)
      const score = availableWeight ? Object.entries(bestOverallWeights).reduce((sum, [key, weight]) =>
        sum + (factors[key as keyof typeof bestOverallWeights] ?? 0) * weight, 0) / availableWeight : 0
      const coverage = features?.coverage === 'complete' ? 1 : 0.75
      const sample = (features?.observations ?? 0) >= 5 ? 1 : 0.7
      const confidence = availableWeight * coverage * sample * (candidate.listing.seller ? 1 : 0.8)
      const reasons = [`Listing ${priceSol} SOL đã qua bộ lọc ngân sách.`]
      if (factors.priceAttractiveness !== null) reasons.push(`Mức giá so với floor được ghi nhận: ${Math.round(factors.priceAttractiveness * 100)}%.`)
      if (factors.activity !== null) reasons.push('Dùng hoạt động giao dịch collection thực tế; không gán số giao dịch collection cho từng NFT.')
      if (factors.liquidity !== null) reasons.push(`Điểm thanh khoản từ dữ liệu quan sát: ${Math.round(factors.liquidity * 100)}/100.`)
      if (factors.momentum !== null) reasons.push('Momentum chỉ phản ánh thay đổi quan sát được, không phải dự báo.')
      if (factors.rarity === null) reasons.push('Không có dữ liệu rarity đáng tin cậy; không suy đoán độ hiếm.')
      if (factors.risk !== null) reasons.push(`Điểm rủi ro heuristic: ${factors.risk}/100.`)
      if (availableWeight < 1) reasons.push('Trọng số metric thiếu được phân bổ lại trên các metric có dữ liệu.')
      return { candidate, ranking: {
        score: Math.round(score * 100), confidence: Math.round(confidence * 100),
        components: { intentMatch: candidate.relevance, preferenceMatch: null, visualMatch: null,
          rarity: factors.rarity, marketQuality: factors.riskQuality, priceFit: factors.priceAttractiveness },
        marketFactors: factors, reasons,
      } }
    }
    const components: AcquisitionRanking['components'] = {
      intentMatch: candidate.relevance,
      preferenceMatch: null,
      visualMatch: null,
      rarity: candidate.rarityScore ?? null,
      marketQuality: candidate.listing.seller
        ? candidate.marketData?.collectionFloorLamports
          ? (BigInt(candidate.marketData.collectionFloorLamports) > 0n && price <= BigInt(candidate.marketData.collectionFloorLamports) ? 0.8 : 0.65)
          : 0.55
        : null,
      priceFit: budget > 0n ? Number((budget - price) * 1_000_000n / budget) / 1_000_000 : null,
    }
    const weighted = Object.entries(this.config.weights) as [keyof typeof this.config.weights, number][]
    const availableWeight = weighted.reduce((sum, [key, weight]) => sum + (components[key] === null ? 0 : weight), 0)
    const score = availableWeight
      ? weighted.reduce((sum, [key, weight]) => sum + (components[key] ?? 0) * weight, 0) / availableWeight
      : 0
    const confidence = availableWeight * (candidate.listing.seller ? 1 : 0.8)
    const reasons = [`Giá listing được xác minh ở mức ${Number(candidate.listing.priceLamports) / 1e9} SOL, trong ngân sách.`]
    if (candidate.marketData?.collectionFloorLamports) reasons.push('Có floor price hiện tại từ marketplace để đối chiếu listing.')
    if (components.rarity === null) reasons.push('Marketplace không cung cấp rarity rank/score đáng tin cho listing này; không suy đoán độ hiếm.')
    if (components.preferenceMatch === null || components.visualMatch === null) {
      reasons.push('Chưa có hồ sơ sở thích hoặc phân tích hình ảnh đủ dữ liệu để chấm điểm cá nhân hóa.')
    }
    const features = candidate.marketFeatures
    const risk = intent.action === 'BUY' && features ? new NFTRiskAnalyzer().analyze(features).risk : null
    const floor = features?.floorPriceSol ?? (candidate.marketData?.collectionFloorLamports
      ? Number(candidate.marketData.collectionFloorLamports) / 1e9 : undefined)
    const priceSol = Number(candidate.listing.priceLamports) / 1e9
    const marketFactors = intent.action === 'BUY' ? {
      activity: features?.sales24h === undefined ? null : clamp01(Math.log1p(features.sales24h) / Math.log(101)),
      liquidity: features?.liquidityScore === undefined ? null : clamp01(features.liquidityScore / 100),
      priceAttractiveness: floor !== undefined && floor > 0 && priceSol > 0 ? clamp01(floor / priceSol) : null,
      momentum: features ? momentumSignal(features) : null,
      rarity: candidate.rarityScore ?? null,
      riskQuality: risk === null ? null : 1 - risk / 100,
      risk,
    } : undefined
    return {
      candidate,
      ranking: {
        score: Math.round(score * 100),
        confidence: Math.round(confidence * 100),
        components,
        ...(marketFactors ? { marketFactors } : {}),
        reasons,
      },
    }
  }

  select(candidates: NFTCandidate[], intent: NFTSearchIntent): RankedNFT | undefined {
    const ranked = candidates
      .filter(candidate => BigInt(candidate.listing.priceLamports) > 0n && BigInt(candidate.listing.priceLamports) <= BigInt(intent.maximumLamports))
      .filter(candidate => candidate.provider !== 'tensor' || (!!candidate.asset && candidate.asset.owner === candidate.marketplaceListing?.listingId
        && candidate.asset.mint === candidate.mint && candidate.asset.network === 'devnet'
        && candidate.marketplaceListing?.status === 'LISTED'
        && Date.now() - Date.parse(candidate.asset.verifiedAt) < 120000
        && !['MOST_BOUGHT', 'STRONGEST_MOMENTUM', 'TRENDING', 'BEST_LIQUIDITY'].includes(intent.objective ?? '')
        && (intent.objective !== 'RARITY' || candidate.rarityScore !== undefined)))
      .filter(candidate => !candidate.mint || !intent.excludedMints.includes(candidate.mint))
      .map(candidate => this.rank(candidate, intent))
      .sort((a, b) => (['LOWEST_PRICE', 'HIGHEST_PRICE'].includes(intent.objective ?? '')
        ? (intent.objective === 'HIGHEST_PRICE' ? -1 : 1) * Number(BigInt(a.candidate.listing.priceLamports) - BigInt(b.candidate.listing.priceLamports)) : b.ranking.score - a.ranking.score)
        || Number(BigInt(a.candidate.listing.priceLamports) - BigInt(b.candidate.listing.priceLamports)))
    return ranked.find(({ candidate, ranking }) => {
      if (candidate.provider === 'tensor') return true // On-chain eligibility checked above; score ranks available evidence.
      const autoBuy = intent.action === 'BUY'
      const verifiedTensorDevnet = autoBuy && candidate.provider === 'tensor'
        && candidate.sourceNetwork === 'devnet'
      return ranking.score >= (autoBuy ? this.config.minAutoBuyScore : this.config.minScore)
        && ranking.confidence >= (autoBuy ? this.config.minAutoBuyConfidence : this.config.minConfidence)
        && (!autoBuy || verifiedTensorDevnet || ranking.marketFactors?.risk !== null && ranking.marketFactors?.risk !== undefined
          && ranking.marketFactors.risk <= this.config.maxAutoBuyRisk)
    })
  }
}
