import { getBase58Decoder, parseBase64RpcAccount, type Address } from '@solana/web3.js'
import { decodeListState, getListStateDiscriminatorBytes, type ListState } from '@tensor-foundation/marketplace'
import { chunk, mapWithConcurrency } from './concurrency.js'
import { TensorAdapterError, withReadRetry } from './errors.js'
import {
  ACCOUNT_BATCH_SIZE,
  BATCH_CONCURRENCY,
  TENSOR_MARKETPLACE_PROGRAM_ADDRESS,
  devnetRpc,
  fetchAllMaybeMetadata,
  fetchEncodedAccounts,
  metadataPdasFor,
  publiclyBuyable,
  scopeSignal,
  some,
  supportedTokenStandard,
} from './rpc.js'
import type { TensorScanDiagnostics, TensorScanResult, TensorListing } from './types.js'

const LIST_STATE_DISCRIMINATOR = getBase58Decoder().decode(getListStateDiscriminatorBytes())

/**
 * Attempts per account-read batch.
 *
 * The configured Devnet endpoint resets a large share of connections: 3 of 12 back-to-back reads
 * failed with ECONNRESET when measured, and one reset used to abort the entire scan. That turned a
 * transient transport fault into "marketplace unavailable" with zero listings, so a BUY request
 * could never reach a verified candidate. Retrying is safe because these reads are idempotent and
 * read-only: they never change a listing, an authorization or a payment, and budget, mandate,
 * ownership and price checks all still run afterwards.
 */
const ACCOUNT_READ_ATTEMPTS = 4
/** Base backoff between batch attempts; jitter is added by withReadRetry. */
const ACCOUNT_READ_BASE_DELAY_MS = 150

/**
 * Server-side filter for the program-account scan.
 *
 * Only the ListState discriminator is used. Tensor writes it at offset 0, and on Devnet it selects
 * exactly the 551 ListState accounts the program owns: a probe of the same query without the filter
 * returned the identical set, and every account measured 317 bytes. `dataSize: 317` was evaluated and
 * also returned the same 551 accounts, but it was not adopted: it would hardcode a mutable layout
 * constant and silently return zero listings - indistinguishable from an empty market - if Tensor
 * ever changed the ListState size. The discriminator alone is already exact, and the decode step
 * below asserts the layout instead of assuming it.
 */
const LIST_STATE_FILTERS = [{ memcmp: { bytes: LIST_STATE_DISCRIMINATOR, encoding: 'base58' as const, offset: 0n } }]

type Candidate = { address: string; state: ListState }

/** Decodes every returned account, counting rows whose layout no longer matches the SDK. */
function decodeListStates(rows: readonly { pubkey: Address; account: Parameters<typeof parseBase64RpcAccount>[1] }[]) {
  const candidates: Candidate[] = []
  let undecodable = 0
  for (const row of rows) {
    try {
      const decoded = decodeListState(parseBase64RpcAccount(row.pubkey, row.account))
      if (!decoded.exists) {
        undecodable++
        continue
      }
      candidates.push({ address: row.pubkey, state: decoded.data })
    } catch {
      undecodable++
    }
  }
  return { candidates, undecodable }
}

function buildListings(candidates: readonly Candidate[], metadata: readonly unknown[], mintAccounts: readonly unknown[]) {
  const listings: TensorListing[] = []
  let metadataMissing = 0
  let unsupportedStandards = 0
  const verified: { candidate: Candidate; name: string; symbol: string; index: number }[] = []
  for (const [index, candidate] of candidates.entries()) {
    const item = metadata[index] as { exists?: boolean; data?: { mint?: string; name?: string; symbol?: string; tokenStandard?: unknown } } | undefined
    if (!item?.exists || item.data?.mint !== candidate.state.assetId) {
      metadataMissing++
      continue
    }
    if (!supportedTokenStandard(some(item.data.tokenStandard as never))) {
      unsupportedStandards++
      continue
    }
    verified.push({ candidate, name: item.data.name?.trim() || candidate.state.assetId,
      symbol: item.data.symbol?.trim() ?? '', index })
  }
  for (const entry of verified) {
    const account = mintAccounts[entry.index] as { exists?: boolean; programAddress?: string } | undefined
    if (!account?.exists || account.programAddress !== 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') {
      unsupportedStandards++
      continue
    }
    listings.push({ listState: entry.candidate.address, mint: entry.candidate.state.assetId, seller: entry.candidate.state.owner,
      priceLamports: entry.candidate.state.amount.toString(), expiry: entry.candidate.state.expiry.toString(),
      name: entry.name, symbol: entry.symbol })
  }
  return { listings, metadataMissing, unsupportedStandards }
}

/**
 * Reads account batches with bounded concurrency so a large candidate set cannot self-throttle.
 *
 * Each batch is retried on its own, so a single reset connection no longer destroys the whole
 * result set. A batch that still fails after every attempt propagates, so an actually unreachable
 * endpoint is reported as unavailable rather than as an empty market.
 */
async function fetchAccountBatches<T>(operation: string, addresses: readonly Address[],
  read: (batch: Address[]) => Promise<T[]>, signal: AbortSignal) {
  const batches = chunk(addresses, ACCOUNT_BATCH_SIZE).map(batch => [...batch])
  const results = await mapWithConcurrency(batches, BATCH_CONCURRENCY, batch =>
    withReadRetry(operation, () => read(batch),
      { signal, attempts: ACCOUNT_READ_ATTEMPTS, baseDelayMs: ACCOUNT_READ_BASE_DELAY_MS }))
  return results.flat()
}

/**
 * Scans Devnet Tensor ListState accounts and returns the cheapest verified listings.
 *
 * `limit` caps the returned listings; it does not cap the RPC response, because Solana's
 * `getProgramAccounts` has no limit parameter and the adapter never truncates a scan silently. The
 * full account set is always decoded and filtered, and the scan reports how many accounts it read,
 * how many were active, and per-operation diagnostics.
 */
export async function scanTensorDevnetListings(
  rpcUrl: string,
  maximumLamports: bigint,
  limit = 50,
  signal?: AbortSignal,
  options: { timeoutMs?: number } = {},
): Promise<TensorScanResult> {
  // One total scan budget, including retries; the caller may cancel earlier.
  const scope = scopeSignal(signal, options.timeoutMs)
  const diagnostics: TensorScanDiagnostics[] = []

  const runPhase = async <T>(operation: TensorScanDiagnostics['operation'], run: () => Promise<T>,
    accountsRead: (value: T) => number): Promise<T> => {
    const at = Date.now()
    try {
      scope.signal.throwIfAborted()
      const value = await run()
      scope.signal.throwIfAborted()
      diagnostics.push({ operation, durationMs: Date.now() - at, accountsRead: accountsRead(value) })
      return value
    } catch (error) {
      const failure = scope.classified(error)
      // classifyRpcFailure only knows the generic "read" operation, so the phase name is attached here.
      // Without it an operator sees "discovery failed" but not which RPC step produced the failure.
      const labelled = failure.operation === operation ? failure
        : new TensorAdapterError(failure.category, operation, { httpStatus: failure.httpStatus,
          rpcCode: failure.rpcCode, timeoutSource: failure.timeoutSource, cause: failure })
      diagnostics.push({ operation, durationMs: Date.now() - at, accountsRead: 0, category: labelled.category,
        ...(labelled.httpStatus !== undefined ? { httpStatus: labelled.httpStatus } : {}),
        ...(labelled.timeoutSource ? { timeoutSource: labelled.timeoutSource } : {}) })
      // Only sanitized fields leave the scanner; raw transport causes can contain credentials.
      throw new TensorAdapterError(labelled.category, operation, { httpStatus: labelled.httpStatus,
        rpcCode: labelled.rpcCode, timeoutSource: labelled.timeoutSource, diagnostics })
    }
  }

  const { rpc } = await runPhase('getGenesisHash', () => withReadRetry('getGenesisHash',
    () => devnetRpc(rpcUrl, scope), { signal: scope.signal, attempts: ACCOUNT_READ_ATTEMPTS,
      baseDelayMs: ACCOUNT_READ_BASE_DELAY_MS }), () => 0)

  const rows = await runPhase('getProgramAccounts', () => withReadRetry('getProgramAccounts',
    () => rpc.getProgramAccounts(TENSOR_MARKETPLACE_PROGRAM_ADDRESS, { encoding: 'base64', filters: LIST_STATE_FILTERS })
      .send({ abortSignal: scope.signal }), { signal: scope.signal, attempts: ACCOUNT_READ_ATTEMPTS,
      baseDelayMs: ACCOUNT_READ_BASE_DELAY_MS }), value => value.length)

  // A discriminator match whose bytes do not decode means the on-chain layout changed. Reporting an
  // empty market here would be exactly the silent, fabricated "no listings" answer we must avoid.
  const { candidates: decoded } = await runPhase('decode', async () => {
    const result = decodeListStates(rows)
    if (rows.length > 0 && result.candidates.length === 0) {
      throw new TensorAdapterError('INVALID_DATA', 'decodeListState')
    }
    if (result.undecodable > 0 && result.undecodable > rows.length / 2) {
      throw new TensorAdapterError('INVALID_DATA', 'decodeListState')
    }
    return result
  }, value => value.candidates.length)

  const nowSeconds = BigInt(Math.floor(Date.now() / 1000))
  const candidates = decoded.filter(({ state }) => publiclyBuyable(state, nowSeconds) && state.amount <= maximumLamports)

  const metadata = await runPhase('metadata', async () => {
    const metadataPdas = await metadataPdasFor(candidates.map(({ state }) => state.assetId))
    return fetchAccountBatches('metadata', metadataPdas,
      batch => fetchAllMaybeMetadata(rpc, batch, { abortSignal: scope.signal }), scope.signal)
  }, value => value.length)

  const mintAccounts = await runPhase('mintAccounts', () => fetchAccountBatches('mintAccounts',
    candidates.map(({ state }) => state.assetId),
    batch => fetchEncodedAccounts(rpc, batch, { abortSignal: scope.signal }), scope.signal), value => value.length)

  const { listings, metadataMissing, unsupportedStandards } = buildListings(candidates, metadata, mintAccounts)
  listings.sort((left, right) => BigInt(left.priceLamports) < BigInt(right.priceLamports) ? -1
    : BigInt(left.priceLamports) > BigInt(right.priceLamports) ? 1 : left.mint.localeCompare(right.mint))
  return { listings: listings.slice(0, limit), scanned: rows.length, activeSolListings: candidates.length,
    metadataMissing, unsupportedStandards, diagnostics }
}
