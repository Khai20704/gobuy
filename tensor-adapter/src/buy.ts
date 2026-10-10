import {
  address,
  createNoopSigner,
  isSignerRole,
  isWritableRole,
} from '@solana/web3.js'
import {
  TENSOR_MARKETPLACE_PROGRAM_ADDRESS,
  fetchMaybeListState,
  findListStatePda,
  getBuyLegacyInstructionAsync,
} from '@tensor-foundation/marketplace'
import { fetchMaybeMetadata } from '@tensor-foundation/mpl-token-metadata'
import { findMetadataPda } from '@tensor-foundation/resolvers'
import { fetchEncodedAccount } from '@solana/web3.js'
import {
  TOKEN_PROGRAM,
  devnetRpc,
  publiclyBuyable,
  scopeSignal,
  some,
  supportedTokenStandard,
} from './rpc.js'
import type { TensorBuyInstruction } from './types.js'

/** Default deadline for building one buy instruction. */
const BUY_TIMEOUT_MS = 15_000

/**
 * Builds the BuyLegacy instruction for a specific buyer and payer.
 *
 * `buyer` receives the NFT (its associated token account is the destination) and `payer` signs and
 * pays. They are the same for a plain wallet purchase; passing a separate `payerValue` lets
 * GoBuy's Vault PDA pay while the mandate owner still receives the original NFT.
 *
 * Every guard below re-reads on-chain state rather than trusting the listing snapshot that discovery
 * returned, so a listing that expired, changed price, became private or lost its metadata is rejected
 * before any transaction is built.
 */
export async function buildTensorLegacyBuyInstruction(
  rpcUrl: string,
  mintValue: string,
  buyerValue: string,
  maximumLamports: bigint,
  signal: AbortSignal = AbortSignal.timeout(BUY_TIMEOUT_MS),
  payerValue = buyerValue,
): Promise<TensorBuyInstruction> {
  const scope = scopeSignal(signal, BUY_TIMEOUT_MS)
  const { rpc } = await devnetRpc(rpcUrl, scope)
  const mint = address(mintValue)
  const buyer = address(buyerValue)
  const [listStateAddress] = await findListStatePda({ mint })

  let account, mintAccount, metadataAccount
  try {
    account = await fetchMaybeListState(rpc, listStateAddress, { abortSignal: scope.signal })
    if (!account.exists || account.programAddress !== TENSOR_MARKETPLACE_PROGRAM_ADDRESS) {
      throw new Error('LISTING_UNAVAILABLE')
    }
    const state = account.data
    if (!publiclyBuyable(state, BigInt(Math.floor(Date.now() / 1000))) || state.amount > maximumLamports) {
      throw new Error('Tensor listing is expired, restricted, non-SOL, or above the requested budget.')
    }
    mintAccount = await fetchEncodedAccount(rpc, mint, { abortSignal: scope.signal })
    if (!mintAccount.exists || mintAccount.programAddress !== TOKEN_PROGRAM) {
      throw new Error('Tensor buy adapter only supports classic SPL Token NFT mints.')
    }
    const [metadataAddress] = await findMetadataPda({ mint })
    metadataAccount = await fetchMaybeMetadata(rpc, metadataAddress, { abortSignal: scope.signal })
    if (!metadataAccount.exists || metadataAccount.data.mint !== mint) {
      throw new Error('Tensor listing has no matching Metaplex metadata account.')
    }
    const standard = some(metadataAccount.data.tokenStandard)
    if (!supportedTokenStandard(standard)) {
      throw new Error('Tensor buy adapter currently supports only Legacy non-fungible token standards.')
    }
  } catch (error) {
    // Guard failures are deliberate, caller-visible rejections: never reclassify them as transport faults.
    if (error instanceof Error && !(error.name === 'TensorAdapterError')) throw error
    throw scope.classified(error)
  }

  const state = account.data
  const metadata = metadataAccount.data
  const tokenStandard = some(metadata.tokenStandard)
  const programmableConfig = some(metadata.programmableConfig)
  const authorizationRules = programmableConfig?.__kind === 'V1' ? some(programmableConfig.ruleSet) : undefined
  const creators = some(metadata.creators)?.map(creator => creator.address) ?? []

  let instruction
  try {
    instruction = await getBuyLegacyInstructionAsync({
      owner: state.owner,
      mint,
      buyer,
      payer: createNoopSigner(address(payerValue)),
      maxAmount: state.amount,
      rentDestination: state.rentPayer ?? undefined,
      makerBroker: some(state.makerBroker),
      takerBroker: buyer,
      authorizationRules,
      tokenStandard,
      creators,
    })
  } catch (error) {
    throw scope.classified(error)
  }

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
