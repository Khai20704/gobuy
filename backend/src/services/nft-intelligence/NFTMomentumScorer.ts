import type { NFTInvestmentIntent, NFTMarketFeatures } from '@gobuy/shared'
export const clamp = (value: number) => Math.min(100, Math.max(0, value))
export class NFTMomentumScorer {
  score(features: NFTMarketFeatures, intent: NFTInvestmentIntent) {
    const horizon = intent.horizon
    if (intent.objective === 'most_bought') {
      const sales = features.marketScope === 'mint'
        ? horizon === '1h' ? features.mintSales1h : horizon === '7d' ? features.mintSales7d : features.mintSales24h
        : undefined
      const signals = sales === undefined ? [] : [{
        name: 'sales', value: sales, contribution: Math.min(100, Math.log1p(sales) * 25),
      }]
      return { momentum: signals[0]?.contribution ?? null, coverage: sales === undefined ? 0 : 1,
        signals, directionalSignals: sales === undefined ? 0 : 1 }
    }
    const weighted = [
      { name: 'volume', weight: 0.30, value: features[`volumeChange${horizon}`] },
      { name: 'floor', weight: 0.25, value: features[`floorChange${horizon}`] },
      { name: 'sales', weight: 0.20, value: features[`salesChange${horizon}`] },
      { name: 'buyers', weight: 0.15, value: features[`buyerChange${horizon}`] },
      { name: 'liquidity', weight: 0.10, value: features.liquidityScore },
    ].filter(metric => metric.value !== undefined)
    const coverage = weighted.reduce((sum, metric) => sum + metric.weight, 0)
    const signals = weighted.map(metric => ({ name: metric.name, value: metric.value!,
      contribution: (metric.name === 'liquidity' ? clamp(metric.value!) : clamp(50 + metric.value! / 2)) * metric.weight / coverage }))
    return { momentum: coverage ? signals.reduce((sum, metric) => sum + metric.contribution, 0) : null,
      coverage, signals, directionalSignals: weighted.filter(metric => metric.name !== 'liquidity').length }
  }
}
