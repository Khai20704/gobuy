import { z } from 'zod'
import type { NFTMarketFeatures, NFTScore, NFTSearchIntent, DiscoveryReply } from '@gobuy/shared'
import type { LLMRouter } from '../../ai/LLMRouter.js'
import { parseModelJSON } from '../../ai/LLMRouter.js'
import { evaluateCandidates, acquisitionLog } from '../acquisition/discovery.js'
import { normalizeFeatures, addMarketHistory } from './NFTFeatureNormalizer.js'
import { NFTMomentumScorer, clamp } from './NFTMomentumScorer.js'
import { NFTRiskAnalyzer } from './NFTRiskAnalyzer.js'
import { NFTSnapshotStore } from './NFTSnapshotStore.js'
import type { NFTDiscoveryProvider } from '../acquisition/discovery.js'
import { ProviderRequestError, type ProviderFailureCode } from '../search/http.js'

const providerMessage = (code: ProviderFailureCode) => ({
  DISABLED: 'Nguồn dữ liệu đã tắt.', AUTH_REQUIRED: 'Tính năng này cần API key.', NETWORK_ERROR: 'Lỗi kết nối marketplace.',
  SCHEMA_MISMATCH: 'Dữ liệu marketplace không khớp schema.', NO_MATCH: 'Không có listing khớp.',
  AUTHENTICATION_FAILED: 'API key bị từ chối.',
  ACCESS_FORBIDDEN: 'API không cấp quyền cho endpoint.',
  RATE_LIMITED: 'API đang giới hạn lượt truy cập.',
  PROVIDER_UNAVAILABLE: 'Dịch vụ marketplace đang lỗi.',
  INVALID_RESPONSE: 'API trả dữ liệu không đúng định dạng.',
  RESPONSE_TOO_LARGE: 'Phản hồi marketplace vượt giới hạn an toàn.',
  TIMEOUT: 'Marketplace phản hồi quá thời gian.',
  NO_DATA: 'Marketplace không trả dữ liệu có thể dùng.',
})[code]

export class NFTRankingService {
  constructor(private readonly snapshots = new NFTSnapshotStore(), private readonly router?: Pick<LLMRouter, 'generate' | 'isConfigured'>) {}
  score(features: NFTMarketFeatures, intent: NonNullable<NFTSearchIntent['investment']>): NFTScore {
    const momentum = new NFTMomentumScorer().score(features, intent)
    const risk = new NFTRiskAnalyzer().analyze(features)
    const liquidity = features.liquidityScore ?? null
    const objectiveScore = intent.objective === 'best_liquidity' ? liquidity
      : intent.objective === 'value' ? features.floorPriceSol && features.priceSol > 0
        ? clamp(50 + (features.floorPriceSol / features.priceSol - 1) * 100) : null
        : momentum.momentum
    const confidence = Math.round((intent.objective === 'best_liquidity' ? liquidity !== null ? 70 : 0
      : intent.objective === 'value' ? objectiveScore !== null && liquidity !== null ? 65 : 0 : momentum.coverage * 100)
      * (features.coverage === 'complete' ? 1 : 0.5) * (features.observations >= 5 ? 1 : 0.5))
    const enough = intent.objective === 'most_bought' ? momentum.directionalSignals >= 1
      : ['value', 'best_liquidity'].includes(intent.objective) || momentum.directionalSignals >= 2
    const maxRisk = intent.riskTolerance === 'low' ? 25 : intent.riskTolerance === 'high' ? 70 : 50
    const eligible = objectiveScore !== null && enough && confidence >= 40 && liquidity !== null && liquidity >= 20
      && risk.risk <= maxRisk && (intent.riskTolerance !== 'low' || features.collectionVerified === true)
    return { momentum: momentum.momentum === null ? null : Math.round(momentum.momentum), liquidity,
      risk: risk.risk, confidence, finalScore: objectiveScore === null || liquidity === null ? null
        : Math.round(clamp(objectiveScore * (0.5 + liquidity / 200) - risk.risk * 0.5)),
      eligible, signals: momentum.signals, warnings: [...risk.warnings,
        ...(!enough ? ['Không đủ tín hiệu độc lập cho momentum.'] : []), 'Momentum hiện tại không bảo đảm tăng giá trong tương lai.'] }
  }
  async search(intent: NFTSearchIntent, providers: NFTDiscoveryProvider[]): Promise<Pick<DiscoveryReply, 'status' | 'sources' | 'candidates' | 'warnings' | 'intelligence'>> {
    if (!intent.investment) return { status: 'NO_MATCH', sources: [], candidates: [], warnings: ['Thiếu tiêu chí nghiên cứu thị trường.'] }
    const warnings: string[] = []
    const batches = await Promise.all(providers.map(async provider => {
      const signal = AbortSignal.timeout(15000)
      try {
        const result = await Promise.race([provider.search(intent, signal), new Promise<never>((_, reject) =>
          signal.addEventListener('abort', () => reject(new Error('timeout')), { once: true }))])
        const normalized = Array.isArray(result) ? { candidates: result } : result
        warnings.push(...(normalized.warnings ?? []))
        return { candidates: normalized.candidates, source: { provider: provider.name, status: 'AVAILABLE' as const } }
      } catch (error) {
        const code: ProviderFailureCode = error instanceof ProviderRequestError ? error.code
          : error instanceof Error && error.name === 'TimeoutError' ? 'TIMEOUT' : 'PROVIDER_UNAVAILABLE'
        const httpStatus = error instanceof ProviderRequestError ? error.status : undefined
        warnings.push(`${provider.name}: ${providerMessage(code)} Không dùng catalog giả thay thế.`)
        acquisitionLog('provider_failure', { provider: provider.name, outcome: code, ...(httpStatus ? { httpStatus } : {}) })
        return { candidates: [], source: { provider: provider.name, status: 'UNAVAILABLE' as const, code, ...(httpStatus ? { httpStatus } : {}) } }
      }
    }))
    const sources = batches.map(batch => batch.source)
    if (!sources.some(source => source.status === 'AVAILABLE')) {
      return { status: 'DATA_UNAVAILABLE', sources, candidates: [], warnings }
    }
    const eligible = evaluateCandidates(batches.flatMap(batch => batch.candidates).filter(c => c.sourceNetwork === 'mainnet'), intent, 24)
    const ranked = await Promise.all(eligible.map(async candidate => {
      let features = candidate.marketFeatures ?? normalizeFeatures(candidate, [], false)
      try { features = addMarketHistory(features, await this.snapshots.history(candidate.collection)) }
      catch { warnings.push('Kho snapshot chưa sẵn sàng; không suy diễn biến động giá sàn.'); acquisitionLog('snapshot', { outcome: 'unavailable' }) }
      const score = this.score(features, intent.investment!)
      try { await this.snapshots.record(features, score) }
      catch { warnings.push('Chưa lưu được snapshot thị trường.'); acquisitionLog('snapshot', { outcome: 'write_failed' }) }
      return { candidate, features, score }
    }))
    const selected = ranked.filter(row => row.score.eligible).sort((a, b) => b.score.finalScore! - a.score.finalScore!
      || Number(BigInt(a.candidate.listing.priceLamports) - BigInt(b.candidate.listing.priceLamports)) || a.candidate.id.localeCompare(b.candidate.id))[0]
    if (!selected) return { status: ranked.length ? 'INSUFFICIENT_DATA' : 'NO_MATCH', sources, candidates: [], warnings: [...new Set([...warnings,
      'Không có ứng viên đủ giá, thanh khoản, dữ liệu và mức rủi ro yêu cầu.', ...ranked.flatMap(row => row.score.warnings)])] }
    const facts = selected.score.signals.map(signal => `${signal.name} (${intent.investment!.horizon}): ${Number(signal.value).toFixed(2)}${signal.name === 'liquidity' ? '/100' : signal.name === 'sales' ? ' giao dịch' : '%'}`)
    let chosenFacts = facts
    // LLM selects supported evidence to explain. It cannot write new numerical claims or change ranking.
    if (this.router?.isConfigured() && facts.length) {
      const schema = z.object({ signalIndices: z.array(z.number().int().min(0).max(facts.length - 1)).min(1).max(facts.length) }).strict()
      try {
        const reply = await this.router.generate({ operation: 'nft_explanation', responseFormat: 'json', maxTokens: 600,
          totalTimeoutMs: 8000, jsonSchema: { name: 'nft_evidence', schema: z.toJSONSchema(schema) }, validate: value => schema.parse(value),
          systemPrompt: 'Choose the most useful evidence indices for explaining this deterministic NFT ranking. Return signalIndices only. Do not invent evidence or predict returns.',
          messages: [{ role: 'user', content: JSON.stringify({ objective: intent.investment, facts }) }] })
        chosenFacts = [...new Set(schema.parse(parseModelJSON(reply.content)).signalIndices)].map(index => facts[index])
      } catch { /* Grounded explanation remains available without LLM. */ }
    }
    return { status: 'MATCHED', sources, candidates: [selected.candidate], warnings: [...new Set([...warnings, ...selected.score.warnings])],
      intelligence: { objective: intent.investment, features: selected.features, score: selected.score,
        explanation: `Xếp hạng theo ${intent.investment.objective} trong ${intent.investment.horizon}. ${chosenFacts.join('; ')}. Điểm thể hiện tín hiệu quan sát, không phải xác suất sinh lời.` } }
  }
}
