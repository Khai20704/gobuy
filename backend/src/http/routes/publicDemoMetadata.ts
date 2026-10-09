import { Router } from 'express'
import { assetStore } from '../../persistence/AssetStore.js'
import { demoImageUrl, demoNftImage } from '../../services/delivery/metadataUrl.js'

/** Read-only public assets. Never initialize a delivery chain, signer or worker here. */
export function publicDemoMetadataRoutes(read = (id: string) => assetStore<Record<string, unknown>>('deliveryMetadata').get('public', id)) {
  const router = Router()
  router.use((req, _res, next) => req.method === 'GET' ? next() : next('router'))
  router.get('/demo-nft-image.svg', (_req, res) => {
    res.set('Access-Control-Allow-Origin', '*').set('Cache-Control', 'public, max-age=86400')
    res.type('image/svg+xml').send(demoNftImage)
  })
  router.get('/delivery-metadata/:id', async (req, res) => {
    if (!/^[a-f0-9]{64}$/.test(req.params.id)) { res.sendStatus(404); return }
    const metadata = await read(req.params.id)
    if (!metadata) { res.sendStatus(404); return }
    if (metadata.symbol !== 'DEMO-NFT') {
      res.set('Access-Control-Allow-Origin', '*').json(metadata); return
    }
    // Legacy transfer plans may have cached original artwork. Public demo metadata must
    // never imply that a replacement is the original marketplace asset.
    res.set('Access-Control-Allow-Origin', '*').json({ ...metadata,
      name: `GoBuy Devnet Demo · ${String(metadata.name ?? 'NFT').replace(/^GoBuy (?:Devnet Demo|DEMO) · /, '')}`.slice(0, 80),
      symbol: metadata.symbol ?? 'DEMO-NFT',
      description: 'GoBuy simulation on Solana Devnet. Not the original marketplace NFT; no creator affiliation or real asset ownership.',
      image: metadata.assetStandard === 'METAPLEX_CORE' ? metadata.image : demoImageUrl(),
      attributes: [...(Array.isArray(metadata.attributes) ? metadata.attributes : []).filter(item => item.trait_type !== 'Type'),
        { trait_type: 'Type', value: 'Demo / Simulated NFT' }],
    })
  })
  return router
}
