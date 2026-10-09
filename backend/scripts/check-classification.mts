import { RWARegistry } from '../src/services/rwa/RWARegistry.js'
import { AssetResolver } from '../src/services/rwa/AssetResolver.js'
import { mongoDatabase } from '../src/persistence/mongo.js'
try {
  const start = performance.now()
  const registry = await RWARegistry.configured()
  const loaded = performance.now()
  const result = new AssetResolver(registry).resolve('Buy any nft under 1 SOL')
  console.log(JSON.stringify({ registrySize: registry.list().length, loadMs: Math.round(loaded - start),
    classifyMs: Math.round(performance.now() - loaded), assetType: result.assetType }))
} finally { await mongoDatabase.close() }
