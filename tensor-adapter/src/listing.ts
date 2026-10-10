import { address } from '@solana/web3.js'
import {
  TENSOR_MARKETPLACE_PROGRAM_ADDRESS,
  fetchMaybeListState,
  findListStatePda,
} from '@tensor-foundation/marketplace'
import { devnetRpc, listingFromState, publiclyBuyable, scopeSignal } from './rpc.js'
import type { TensorListing } from './types.js'

/** Default deadline for reading one listing. Well above the measured ~1 s single-listing read. */
const LISTING_TIMEOUT_MS = 15_000

function nowSeconds() {
  return BigInt(Math.floor(Date.now() / 1000))
}

/**
 * Reads the canonical ListState PDA for a mint on Devnet.
 * Returns undefined when no public, unexpired, SOL-priced listing exists for that mint.
 */
export async function fetchTensorDevnetListing(
  rpcUrl: string,
  mintValue: string,
  signal?: AbortSignal,
): Promise<TensorListing | undefined> {
  const scope = scopeSignal(signal, LISTING_TIMEOUT_MS)
  const { rpc } = await devnetRpc(rpcUrl, scope)
  const mint = address(mintValue)
  const [listStateAddress] = await findListStatePda({ mint })
  let account
  try {
    account = await fetchMaybeListState(rpc, listStateAddress, { abortSignal: scope.signal })
  } catch (error) {
    throw scope.classified(error)
  }
  if (!account.exists || account.programAddress !== TENSOR_MARKETPLACE_PROGRAM_ADDRESS) return undefined
  if (!publiclyBuyable(account.data, nowSeconds())) return undefined
  return listingFromState(rpc, listStateAddress, account.data, scope)
}

/**
 * Reads a listing by its ListState address and re-derives the PDA from the mint, so a ListState
 * account that is not the canonical PDA for its asset is rejected rather than trusted.
 */
export async function fetchTensorDevnetListingById(
  rpcUrl: string,
  listingId: string,
  signal?: AbortSignal,
): Promise<TensorListing | undefined> {
  const scope = scopeSignal(signal, LISTING_TIMEOUT_MS)
  const { rpc } = await devnetRpc(rpcUrl, scope)
  let account
  try {
    account = await fetchMaybeListState(rpc, address(listingId), { abortSignal: scope.signal })
  } catch (error) {
    throw scope.classified(error)
  }
  if (!account.exists || account.programAddress !== TENSOR_MARKETPLACE_PROGRAM_ADDRESS) return undefined
  if (!publiclyBuyable(account.data, nowSeconds())) return undefined
  const [expected] = await findListStatePda({ mint: account.data.assetId })
  if (expected !== listingId) return undefined
  return listingFromState(rpc, listingId, account.data, scope)
}
