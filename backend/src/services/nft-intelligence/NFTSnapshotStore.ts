import { randomUUID } from 'node:crypto'
import type { NFTMarketFeatures, NFTScore } from '@gobuy/shared'
import { assetStore, type AssetStore } from '../../persistence/AssetStore.js'
import { mongoDatabase, storageMode } from '../../persistence/mongo.js'
const retentionMs = 90 * 24 * 60 * 60 * 1000
const maxPerMint = 500
const maxFileRecords = 10000
const pruneIntervalMs = 60 * 60 * 1000
export type MarketSnapshot = { id: string; features: NFTMarketFeatures; score: NFTScore }
type PredictionRecord = { id: string; mint: string; collection: string; observedAt: string; priceSol: number;
  kind: 'ranking_observation'; finalScore: number | null }
export class NFTSnapshotStore {
  private lastPrunedAt = 0
  constructor(private readonly snapshots: AssetStore<MarketSnapshot> = assetStore('nftMarketSnapshots'),
    private readonly predictions: AssetStore<PredictionRecord> = assetStore('nftPredictions'),
    private readonly results = assetStore<{ predictionId: string; horizon: string; observedReturnPercent: number; observedAt: string; basis: 'listing_price_not_realized_return' }>('nftPredictionResults'),
    private readonly mongo = storageMode() === 'mongo') {}
  async history(collection: string): Promise<NFTMarketFeatures[]> {
    if (this.mongo) {
      const rows = await (await mongoDatabase.get()).collection('nftMarketSnapshots')
        .find({ 'value.features.collection': collection }).sort({ 'value.features.observedAt': -1 }).limit(500).toArray()
      return rows.map(row => row.value.features as NFTMarketFeatures)
    }
    return (await this.snapshots.list('market')).filter(row => row.features.collection === collection).map(row => row.features)
  }
  async record(features: NFTMarketFeatures, score: NFTScore) {
    const id = randomUUID()
    await this.snapshots.put('market', id, { id, features, score }, true)
    await this.predictions.put('market', id, { id, mint: features.mint, collection: features.collection,
      observedAt: features.observedAt, priceSol: features.priceSol, kind: 'ranking_observation', finalScore: score.finalScore }, true)
    const prior: PredictionRecord[] = this.mongo
      ? (await (await mongoDatabase.get()).collection('nftPredictions').find({ 'value.mint': features.mint })
        .sort({ 'value.observedAt': -1 }).limit(500).toArray()).map(row => row.value as PredictionRecord)
      : await this.predictions.list('market')
    for (const prediction of prior.filter(row => row.mint === features.mint && row.priceSol > 0)) {
      const elapsed = Date.parse(features.observedAt) - Date.parse(prediction.observedAt)
      for (const [horizon, hours] of [['1h', 1], ['24h', 24], ['7d', 168]] as const) {
        if (elapsed < hours * 3600000 || elapsed > hours * 3600000 * 1.1) continue
        await this.results.put('market', `${prediction.id}:${horizon}`, { predictionId: prediction.id, horizon,
          observedReturnPercent: (features.priceSol / prediction.priceSol - 1) * 100,
          observedAt: features.observedAt, basis: 'listing_price_not_realized_return' }, true)
      }
    }
        await this.prune(new Date(features.observedAt), features.mint)
  }
  private async prune(now: Date, mint: string) {
        const runRetentionSweep = now.getTime() - this.lastPrunedAt >= pruneIntervalMs
        const cutoff = new Date(now.getTime() - retentionMs).toISOString()
        if (this.mongo) {
          const db = await mongoDatabase.get()
          if (runRetentionSweep) await Promise.all([
              db.collection('nftMarketSnapshots').deleteMany({ 'value.features.observedAt': { $lt: cutoff } }),
              db.collection('nftPredictions').deleteMany({ 'value.observedAt': { $lt: cutoff } }),
              db.collection('nftPredictionResults').deleteMany({ 'value.observedAt': { $lt: cutoff } }),
            ])
          for (const [name, filter, sortPath] of [
            ['nftMarketSnapshots', { 'value.features.mint': mint }, 'value.features.observedAt'],
            ['nftPredictions', { 'value.mint': mint }, 'value.observedAt'],
          ] as const) {
            const collection = db.collection(name)
            let excess = await collection.find(filter).sort({ [sortPath]: -1 }).skip(maxPerMint).limit(1000).project({ _id: 1 }).toArray()
            while (excess.length) {
              await collection.deleteMany({ _id: { $in: excess.map(row => row._id) } })
              excess = await collection.find(filter).sort({ [sortPath]: -1 }).skip(maxPerMint).limit(1000).project({ _id: 1 }).toArray()
            }
          }
        } else if (runRetentionSweep) {
          const [snapshots, predictions, results] = await Promise.all([
            this.snapshots.list('market', maxFileRecords), this.predictions.list('market', maxFileRecords),
            this.results.list('market', maxFileRecords),
          ])
          const expiredSnapshots = snapshots.filter(row => row.features.observedAt < cutoff)
          const expiredPredictions = predictions.filter(row => row.observedAt < cutoff)
          const expiredResults = results.filter(row => row.observedAt < cutoff)
          const removeSnapshots = new Set([...expiredSnapshots.map(row => row.id),
            ...snapshots.filter(row => row.features.observedAt >= cutoff).sort((a, b) =>
              b.features.observedAt.localeCompare(a.features.observedAt)).slice(maxFileRecords).map(row => row.id)])
          const removePredictions = new Set([...expiredPredictions.map(row => row.id),
            ...predictions.filter(row => row.observedAt >= cutoff).sort((a, b) =>
              b.observedAt.localeCompare(a.observedAt)).slice(maxFileRecords).map(row => row.id)])
          const removeResults = new Set([...expiredResults.map(row => `${row.predictionId}:${row.horizon}`),
            ...results.filter(row => row.observedAt >= cutoff).sort((a, b) => b.observedAt.localeCompare(a.observedAt))
              .slice(maxFileRecords).map(row => `${row.predictionId}:${row.horizon}`)])
          await Promise.all([
            ...[...removeSnapshots].map(id => this.snapshots.take('market', id)),
            ...[...removePredictions].map(id => this.predictions.take('market', id)),
            ...[...removeResults].map(id => this.results.take('market', id)),
          ])
        }
        if (runRetentionSweep) this.lastPrunedAt = now.getTime()
  }
}
