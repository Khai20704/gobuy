import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { investmentPreferencesSchema, type NFTSearchIntent } from '@gobuy/shared'
import type { z } from 'zod'
import { MongoTwinStore } from '../../persistence/MongoTwinStore.js'
import { storageMode } from '../../persistence/mongo.js'
import { FileTwinStore, type TwinStore } from './TwinStore.js'
import { normalizeIntentText } from '../acquisition/intentLanguage.js'
type Preferences = z.infer<typeof investmentPreferencesSchema>
export class InvestmentTwinService {
  constructor(private readonly store: TwinStore = storageMode() === 'mongo' ? new MongoTwinStore()
    : new FileTwinStore(resolve(process.env.TWIN_DATA_DIR || '.data/twins'))) {}
  private key(userId: string) { return createHash('sha256').update(`account:${userId}`).digest('hex') }
  async read(userId: string) { return (await this.store.read(this.key(userId))).explicit.investment ?? {} }
  async update(userId: string, preferences: Preferences) {
    const value = investmentPreferencesSchema.parse(preferences)
    await this.store.update(this.key(userId), twin => ({ ...twin, explicit: { ...twin.explicit, investment: { ...twin.explicit.investment, ...value } } }))
    return this.read(userId)
  }
  async apply(userId: string, intent: NFTSearchIntent, text: string): Promise<NFTSearchIntent> {
    if (!intent.investment) return intent
    const preferences = await this.read(userId), value = normalizeIntentText(text)
    const riskExplicit = /risk|rui ro|an toan|uy tin|reputable/.test(value)
    const horizonExplicit = /\b(1h|24h|7d|gio|ngay|tuan|hour|today|week|hom nay)\b/.test(value)
    const investment = { ...intent.investment,
      riskTolerance: riskExplicit ? intent.investment.riskTolerance : preferences.riskTolerance ?? intent.investment.riskTolerance,
      horizon: horizonExplicit ? intent.investment.horizon : preferences.horizon ?? intent.investment.horizon }
    await this.update(userId, { ...(riskExplicit ? { riskTolerance: investment.riskTolerance } : {}),
      ...(horizonExplicit ? { horizon: investment.horizon } : {}), maxPriceSol: Number(intent.maximumLamports) / 1e9 })
    return { ...intent, investment }
  }
}
