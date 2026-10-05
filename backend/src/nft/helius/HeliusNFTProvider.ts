import { NFTPurchaseError } from '../errors.js'
import { z } from 'zod'
import { walletAddressSchema } from '@gobuy/shared'
import { HeliusClient, HeliusError } from './HeliusClient.js'

const assetSchema = z.object({
  id: walletAddressSchema, interface: z.enum(['V1_NFT', 'ProgrammableNFT']), burnt: z.literal(false),
  compression: z.object({ compressed: z.literal(false) }),
  ownership: z.object({ owner: walletAddressSchema, ownership_model: z.literal('single') }),
  content: z.object({ metadata: z.object({ name: z.string().nullish(), description: z.preprocess(value => value ?? '', z.string()),
    attributes: z.preprocess(value => value ?? [], z.array(z.object({ trait_type: z.string(), value: z.union([z.string(), z.number(), z.boolean()]) }))),
  }).optional(), links: z.object({ image: z.string().optional() }).optional() }).optional(),
  grouping: z.array(z.object({ group_key: z.string(), group_value: walletAddressSchema })).optional(),
})
export type VerifiedNFTAsset = {
  mint: string; name?: string; description?: string; image?: string; owner: string;
  collectionAddress?: string; collectionName?: string; attributes?: { name: string; value: string }[];
  network: 'devnet'; verifiedAt: string;
}
export class HeliusNFTProvider {
  constructor(private readonly client = new HeliusClient()) {}
  async verifyNetwork(signal?: AbortSignal) { await this.client.assertDevnet(signal) }
  async getAsset(mint: string, signal?: AbortSignal): Promise<VerifiedNFTAsset> {
    walletAddressSchema.parse(mint)
    await this.client.assertDevnet(signal)
    const raw = await this.client.call<unknown>('getAsset', { id: mint }, signal)
    if (raw === null) throw new HeliusError('ASSET_NOT_FOUND')
    const parsed = assetSchema.safeParse(raw)
    if (!parsed.success || parsed.data.id !== mint) throw new HeliusError('INVALID_RESPONSE')
    const asset = parsed.data, metadata = asset.content?.metadata
    return { mint, name: metadata?.name ?? undefined, description: metadata?.description ?? '', image: asset.content?.links?.image,
      owner: asset.ownership.owner, collectionAddress: asset.grouping?.find(group => group.group_key === 'collection')?.group_value,
      attributes: metadata?.attributes?.map(trait => ({ name: trait.trait_type, value: String(trait.value) })) ?? [],
      network: 'devnet', verifiedAt: new Date().toISOString() }
  }
  async verifyOwner(mint: string, seller: string, signal?: AbortSignal) {
    const asset = await this.getAsset(mint, signal)
    if (asset.owner !== seller) throw new NFTPurchaseError('LISTING_CHANGED')
    // DAS is indexed. Check current token state again before trusting ownership.
    const accounts = await this.client.call<{ value: { account: { data: { parsed: { info: {
      mint: string; owner: string; tokenAmount: { amount: string; decimals: number }
    } } } } }[] }>('getTokenAccountsByOwner', [seller, { mint }, { encoding: 'jsonParsed', commitment: 'confirmed' }], signal)
    if (!Array.isArray(accounts?.value)) throw new HeliusError('INVALID_RESPONSE')
    if (!accounts.value.some(row => {
      const info = row.account?.data?.parsed?.info
      return info?.mint === mint && info.owner === seller && info.tokenAmount?.amount === '1' && info.tokenAmount.decimals === 0
    })) throw new NFTPurchaseError('LISTING_CHANGED')
    return asset
  }
}
