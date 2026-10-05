// Read-only account binding + live listing diagnostic; no transaction construction or signing.
import { MongoClient } from 'mongodb'
import { TensorDevnetNFTProvider } from '../src/services/acquisition/TensorDevnetNFTProvider.js'
import { NFTIntentParser } from '../src/services/acquisition/discovery.js'
import { storageMode } from '../src/persistence/mongo.js'

const owner = process.argv[2]
let database: MongoClient | undefined
try {
  if (!owner) throw new Error('Public owner address required')
  if (storageMode() === 'mongo' && process.env.MONGODB_URI) {
    database = new MongoClient(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 8000 })
    const db = database.db(process.env.MONGODB_DB_NAME || 'gobuy')
    const linked = await db.collection('walletAssociations').findOne({ 'value.address': owner, 'value.verified': true }, { projection: { _id: 1 } })
    console.log(JSON.stringify({ verifiedGoBuyWalletAssociationExists: !!linked }))
    const storedQuote = await db.collection('orders').findOne({ 'quote.owner': owner, 'quote.sourceAsset.provider': 'tensor' },
      { sort: { createdAt: -1 }, projection: { _id: 0, 'quote.sourceAsset.asset.description': 1, 'quote.sourceAsset.asset.attributes': 1, 'quote.sourceAsset.asset.collectionAddress': 1 } })
    const metadata = storedQuote?.quote?.sourceAsset?.asset
    console.log(JSON.stringify({ persistedQuoteMetadata: metadata ? Object.fromEntries(['description', 'attributes', 'collectionAddress'].map(field =>
      [field, metadata[field] === null ? 'null' : metadata[field] === undefined ? 'missing' : Array.isArray(metadata[field]) ? 'array' : typeof metadata[field]])) : 'No stored Tensor quote' }))
  } else {
    console.log(JSON.stringify({ walletAssociationInspection: 'Requires account-specific verification in file storage' }))
  }
  if (!process.argv.includes('--metadata-only')) {
  const intent = await new NFTIntentParser().parse('Buy Bodega Monke #5 max 1 SOL')
  const candidates = await new TensorDevnetNFTProvider().search(intent, AbortSignal.timeout(30000))
  console.log(JSON.stringify({ selectedExampleListings: candidates.filter(item => item.name === 'Bodega Monke #5').map(item => ({
    name: item.name, mint: item.mint, listingId: item.marketplaceListing?.listingId, seller: item.listing.seller,
    priceLamports: item.listing.priceLamports, network: item.sourceNetwork,
  })) }, null, 2))
  }
} catch (error) {
  console.error('Read-only purchase readiness inspection failed:', error instanceof Error ? error.name : 'Unknown error')
  process.exitCode = 1
} finally { await database?.close() }
