import {
  address,
  createNoopSigner,
  createSolanaRpc,
  fetchEncodedAccount,
  fetchEncodedAccounts,
  getBase58Decoder,
  isSome,
  isSignerRole,
  isWritableRole,
  parseBase64RpcAccount,
  type Address,
} from '@solana/web3.js'
import {
  decodeListState,
  findListStatePda,
  fetchMaybeListState,
  getBuyLegacyInstructionAsync,
  getListStateDiscriminatorBytes,
  TENSOR_MARKETPLACE_PROGRAM_ADDRESS,
  type ListState,
} from '@tensor-foundation/marketplace'
import { fetchAllMaybeMetadata, fetchMaybeMetadata, TokenStandard } from '@tensor-foundation/mpl-token-metadata'
import { findMetadataPda } from '@tensor-foundation/resolvers'

export type TensorListing = {
  listState: string
  mint: string
  seller: string
  priceLamports: string
  expiry: string
  name: string
  symbol: string
}

export type TensorScanResult = {
  listings: TensorListing[]
  scanned: number
  activeSolListings: number
  metadataMissing: number
  unsupportedStandards: number
}

export type TensorBuyInstruction = {
  programAddress: string
  accounts: { address: string; isSigner: boolean; isWritable: boolean }[]
  data: Uint8Array
  mint: string
  seller: string
  listState: string
  priceLamports: string
}

const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG'
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
const LIST_STATE_DISCRIMINATOR = getBase58Decoder().decode(getListStateDiscriminatorBytes())

function some<T>(option: { __option: 'Some'; value: T } | { __option: 'None' }) {
  return option.__option === 'Some' ? option.value : undefined
}

async function devnetRpc(rpcUrl: string, signal: AbortSignal) {
  const rpc = createSolanaRpc(rpcUrl)
  const genesis = await rpc.getGenesisHash().send({ abortSignal: signal })
  if (genesis !== DEVNET_GENESIS) throw new Error('Tensor adapter only permits Solana Devnet RPC.')
  return { rpc }
}

function publiclyBuyable(state: ListState, nowSeconds: bigint) {
  return state.amount > 0n && (state.expiry === 0n || state.expiry > nowSeconds)
    && !isSome(state.currency)
    && !isSome(state.privateTaker)
    && state.cosigner === null
}

async function listingFromState(
  rpc: Awaited<ReturnType<typeof devnetRpc>>['rpc'],
  listState: string,
  state: ListState,
  signal: AbortSignal,
): Promise<TensorListing | undefined> {
  const mintAccount = await fetchEncodedAccount(rpc, address(state.assetId), { abortSignal: signal })
  if (!mintAccount.exists || mintAccount.programAddress !== TOKEN_PROGRAM) return undefined
  const [metadataAddress] = await findMetadataPda({ mint: state.assetId })
  const metadata = await fetchMaybeMetadata(rpc, metadataAddress, { abortSignal: signal })
  if (!metadata.exists || metadata.data.mint !== state.assetId) return undefined
  const standard = some(metadata.data.tokenStandard)
  if (standard !== TokenStandard.NonFungible && standard !== TokenStandard.ProgrammableNonFungible) return undefined
  return {
    listState,
    mint: state.assetId,
    seller: state.owner,
    priceLamports: state.amount.toString(),
    expiry: state.expiry.toString(),
    name: metadata.data.name.trim() || state.assetId,
    symbol: metadata.data.symbol.trim(),
  }
}

export async function fetchTensorDevnetListing(
  rpcUrl: string,
  mintValue: string,
  signal = AbortSignal.timeout(15_000),
): Promise<TensorListing | undefined> {
  const { rpc } = await devnetRpc(rpcUrl, signal)
  const mint = address(mintValue)
  const [listStateAddress] = await findListStatePda({ mint })
  const account = await fetchMaybeListState(rpc, listStateAddress, { abortSignal: signal })
  if (!account.exists || account.programAddress !== TENSOR_MARKETPLACE_PROGRAM_ADDRESS
    || !publiclyBuyable(account.data, BigInt(Math.floor(Date.now() / 1000)))) return undefined
  return listingFromState(rpc, listStateAddress, account.data, signal)
}

export async function fetchTensorDevnetListingById(rpcUrl: string, listingId: string,
  signal = AbortSignal.timeout(15000)): Promise<TensorListing | undefined> {
  const { rpc } = await devnetRpc(rpcUrl, signal)
  const account = await fetchMaybeListState(rpc, address(listingId), { abortSignal: signal })
  if (!account.exists || account.programAddress !== TENSOR_MARKETPLACE_PROGRAM_ADDRESS
    || !publiclyBuyable(account.data, BigInt(Math.floor(Date.now() / 1000)))) return undefined
  const [expected] = await findListStatePda({ mint: account.data.assetId })
  if (expected !== listingId) return undefined
  return listingFromState(rpc, listingId, account.data, signal)
}

export async function scanTensorDevnetListings(
  rpcUrl: string,
  maximumLamports: bigint,
  limit = 50,
  signal = AbortSignal.timeout(15_000),
): Promise<TensorScanResult> {
  const { rpc } = await devnetRpc(rpcUrl, signal)
  const rows = await rpc.getProgramAccounts(TENSOR_MARKETPLACE_PROGRAM_ADDRESS, {
    encoding: 'base64',
    filters: [{
      memcmp: { bytes: LIST_STATE_DISCRIMINATOR, encoding: 'base58', offset: 0n },
    }],
  }).send({ abortSignal: signal })
  const nowSeconds = BigInt(Math.floor(Date.now() / 1000))
  const candidates = rows.map(row => {
    const account = parseBase64RpcAccount(row.pubkey, row.account)
    return { address: row.pubkey, state: decodeListState(account).data }
  }).filter(({ state }) => publiclyBuyable(state, nowSeconds) && state.amount <= maximumLamports)
  const mintAddresses = candidates.map(({ state }) => state.assetId)
  const metadataPdas: Address[] = []
  for (let index = 0; index < mintAddresses.length; index += 50) {
    const batch = await Promise.all(mintAddresses.slice(index, index + 50).map(async mint =>
      (await findMetadataPda({ mint }))[0]))
    metadataPdas.push(...batch)
  }
  const metadata = []
  for (let index = 0; index < metadataPdas.length; index += 50) {
    metadata.push(...await fetchAllMaybeMetadata(rpc, metadataPdas.slice(index, index + 50), { abortSignal: signal }))
  }
  const listings: TensorListing[] = []
  let metadataMissing = 0
  let unsupportedStandards = 0
  const verifiedMetadata: { account: typeof candidates[number]; name: string; symbol: string }[] = []
  for (const [index, account] of candidates.entries()) {
    const item = metadata[index]
    if (!item?.exists || item.data.mint !== account.state.assetId) {
      metadataMissing++
      continue
    }
    const standard = some(item.data.tokenStandard)
    if (standard !== TokenStandard.NonFungible && standard !== TokenStandard.ProgrammableNonFungible) {
      unsupportedStandards++
      continue
    }
    verifiedMetadata.push({
      account,
      name: item.data.name.trim() || account.state.assetId,
      symbol: item.data.symbol.trim(),
    })
  }
  const mintAccounts = []
  for (let index = 0; index < verifiedMetadata.length; index += 50) {
    mintAccounts.push(...await fetchEncodedAccounts(
      rpc,
      verifiedMetadata.slice(index, index + 50).map(item => item.account.state.assetId),
      { abortSignal: signal },
    ))
  }
  for (const [index, item] of verifiedMetadata.entries()) {
    if (!mintAccounts[index]?.exists || mintAccounts[index].programAddress !== TOKEN_PROGRAM) {
      unsupportedStandards++
      continue
    }
    listings.push({
      listState: item.account.address,
      mint: item.account.state.assetId,
      seller: item.account.state.owner,
      priceLamports: item.account.state.amount.toString(),
      expiry: item.account.state.expiry.toString(),
      name: item.name,
      symbol: item.symbol,
    })
  }
  listings.sort((left, right) => BigInt(left.priceLamports) < BigInt(right.priceLamports) ? -1
    : BigInt(left.priceLamports) > BigInt(right.priceLamports) ? 1 : left.mint.localeCompare(right.mint))
  return {
    listings: listings.slice(0, limit),
    scanned: rows.length,
    activeSolListings: candidates.length,
    metadataMissing,
    unsupportedStandards,
  }
}

export async function buildTensorLegacyBuyInstruction(
  rpcUrl: string,
  mintValue: string,
  buyerValue: string,
  maximumLamports: bigint,
  signal = AbortSignal.timeout(15_000),
): Promise<TensorBuyInstruction> {
  const { rpc } = await devnetRpc(rpcUrl, signal)
  const mint = address(mintValue)
  const buyer = address(buyerValue)
  const [listStateAddress] = await findListStatePda({ mint })
  const account = await fetchMaybeListState(rpc, listStateAddress, { abortSignal: signal })
  if (!account.exists || account.programAddress !== TENSOR_MARKETPLACE_PROGRAM_ADDRESS) throw new Error('LISTING_UNAVAILABLE')
  const state = account.data
  const nowSeconds = BigInt(Math.floor(Date.now() / 1000))
  if (!publiclyBuyable(state, nowSeconds) || state.amount > maximumLamports) {
    throw new Error('Tensor listing is expired, restricted, non-SOL, or above the requested budget.')
  }
  const mintAccount = await fetchEncodedAccount(rpc, mint, { abortSignal: signal })
  if (!mintAccount.exists || mintAccount.programAddress !== TOKEN_PROGRAM) {
    throw new Error('Tensor buy adapter only supports classic SPL Token NFT mints.')
  }
  const [metadataAddress] = await findMetadataPda({ mint })
  const metadataAccount = await fetchMaybeMetadata(rpc, metadataAddress, { abortSignal: signal })
  if (!metadataAccount.exists || metadataAccount.data.mint !== mint) {
    throw new Error('Tensor listing has no matching Metaplex metadata account.')
  }
  const metadata = metadataAccount.data
  const tokenStandard = some(metadata.tokenStandard)
  if (tokenStandard !== TokenStandard.NonFungible
    && tokenStandard !== TokenStandard.ProgrammableNonFungible) {
    throw new Error('Tensor buy adapter currently supports only Legacy non-fungible token standards.')
  }
  const programmableConfig = some(metadata.programmableConfig)
  const authorizationRules = programmableConfig?.__kind === 'V1'
    ? some(programmableConfig.ruleSet)
    : undefined
  const creators = some(metadata.creators)?.map(creator => creator.address) ?? []
  const instruction = await getBuyLegacyInstructionAsync({
    owner: state.owner,
    mint,
    payer: createNoopSigner(buyer),
    maxAmount: state.amount,
    rentDestination: state.rentPayer ?? undefined,
    makerBroker: some(state.makerBroker),
    takerBroker: buyer,
    authorizationRules,
    tokenStandard,
    creators,
  })
  return {
    programAddress: instruction.programAddress,
    accounts: instruction.accounts.map(meta => ({
      address: meta.address,
      isSigner: isSignerRole(meta.role),
      isWritable: isWritableRole(meta.role),
    })),
    data: instruction.data,
    mint: state.assetId,
    seller: state.owner,
    listState: listStateAddress,
    priceLamports: state.amount.toString(),
  }
}

export const tensorMarketplaceProgram = TENSOR_MARKETPLACE_PROGRAM_ADDRESS
