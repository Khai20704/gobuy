import {
  address,
  createSolanaRpc,
  fetchEncodedAccount,
  fetchEncodedAccounts,
  isSome,
  type Address,
} from '@solana/web3.js'
import {
  TENSOR_MARKETPLACE_PROGRAM_ADDRESS,
  type ListState,
} from '@tensor-foundation/marketplace'
import { fetchAllMaybeMetadata, fetchMaybeMetadata, TokenStandard } from '@tensor-foundation/mpl-token-metadata'
import { findMetadataPda } from '@tensor-foundation/resolvers'
import { classifyRpcFailure, TensorAdapterError } from './errors.js'
import type { TensorListing } from './types.js'

/** Solana Devnet genesis hash. The adapter refuses to run against any other cluster. */
export const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG'
/** Classic SPL Token program. Token-2022 mints are out of scope for the legacy Tensor buy path. */
export const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
/**
 * Total budget for one adapter call (the complete scan, including all phases and retries).
 * A caller deadline can end the call earlier. It never extends this budget.
 */
export const DEFAULT_OPERATION_TIMEOUT_MS = 20_000
/** Metadata and mint accounts are read in batches; 100 keeps each batch inside common RPC limits. */
export const ACCOUNT_BATCH_SIZE = 100
/** Cap on simultaneous account-batch requests, to avoid self-inflicted 429s. */
export const BATCH_CONCURRENCY = 3

export type SolanaRpc = ReturnType<typeof createSolanaRpc>

export type ScopedSignal = {
  signal: AbortSignal
  /** True when our own budget elapsed rather than the caller's. */
  adapterTimedOut: () => boolean
  classified: (error: unknown) => TensorAdapterError
}

/**
 * Combines the caller's deadline with the adapter's total call budget, so a timeout can be
 * attributed to the right source instead of being reported as an anonymous provider failure.
 */
export function scopeSignal(signal: AbortSignal | undefined, timeoutMs = DEFAULT_OPERATION_TIMEOUT_MS): ScopedSignal {
  const timer = AbortSignal.timeout(timeoutMs)
  const combined = signal ? AbortSignal.any([signal, timer]) : timer
  // AbortSignal.any preserves the first reason, even if the other deadline fires later.
  const adapterTimedOut = () => combined.aborted && timer.aborted && combined.reason === timer.reason
  return {
    signal: combined,
    adapterTimedOut,
    classified: (error: unknown) => combined.aborted
      ? new TensorAdapterError('TIMEOUT', 'read', { timeoutSource: adapterTimedOut() ? 'adapter' : 'caller' })
      : classifyRpcFailure(error),
  }
}

export async function devnetRpc(rpcUrl: string, scope: ScopedSignal) {
  const rpc = createSolanaRpc(rpcUrl)
  let genesis: string
  try {
    genesis = await rpc.getGenesisHash().send({ abortSignal: scope.signal })
  } catch (error) {
    throw scope.classified(error)
  }
  if (genesis !== DEVNET_GENESIS) throw new TensorAdapterError('NETWORK_MISMATCH', 'getGenesisHash')
  return { rpc }
}

export function some<T>(option: { __option: 'Some'; value: T } | { __option: 'None' }) {
  return option.__option === 'Some' ? option.value : undefined
}

/** A listing is buyable only when it is public: no currency override, no private taker, no cosigner. */
export function publiclyBuyable(state: ListState, nowSeconds: bigint) {
  return state.amount > 0n && (state.expiry === 0n || state.expiry > nowSeconds)
    && !isSome(state.currency)
    && !isSome(state.privateTaker)
    && state.cosigner === null
}

export function supportedTokenStandard(standard: TokenStandard | undefined) {
  return standard === TokenStandard.NonFungible || standard === TokenStandard.ProgrammableNonFungible
}

/**
 * Completes a listing by reading the mint account and its Metaplex metadata.
 * Returns undefined when the account is not a classic SPL mint or carries no usable metadata.
 */
export async function listingFromState(
  rpc: SolanaRpc,
  listState: string,
  state: ListState,
  scope: ScopedSignal,
): Promise<TensorListing | undefined> {
  let mintAccount, metadata
  try {
    mintAccount = await fetchEncodedAccount(rpc, address(state.assetId), { abortSignal: scope.signal })
    const [metadataAddress] = await findMetadataPda({ mint: state.assetId })
    metadata = await fetchMaybeMetadata(rpc, metadataAddress, { abortSignal: scope.signal })
  } catch (error) {
    throw scope.classified(error)
  }
  if (!mintAccount.exists || mintAccount.programAddress !== TOKEN_PROGRAM) return undefined
  if (!metadata.exists || metadata.data.mint !== state.assetId) return undefined
  if (!supportedTokenStandard(some(metadata.data.tokenStandard))) return undefined
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

/** Pure PDA derivation for already-decoded mint addresses; no network traffic. */
export function metadataPdasFor(mints: readonly Address[]): Promise<Address[]> {
  return Promise.all(mints.map(async mint => (await findMetadataPda({ mint }))[0]))
}

export { TENSOR_MARKETPLACE_PROGRAM_ADDRESS, fetchAllMaybeMetadata, fetchEncodedAccounts, fetchMaybeMetadata, TokenStandard }
