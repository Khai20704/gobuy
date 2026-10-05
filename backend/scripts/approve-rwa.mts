import { Connection, PublicKey } from '@solana/web3.js'
import { rwaAssetSchema, type RWAAsset } from '@gobuy/shared'
import { mongoDatabase, storageMode } from '../src/persistence/mongo.js'
import { MAINNET_GENESIS, RWA_APPROVED_LIST } from '../src/services/rwa/RWARegistry.js'

/**
 * Operator tool to approve ONE RWA identity by its exact canonical mint.
 *
 * Not reachable from the agent or the HTTP API: an operator runs it deliberately. It verifies the
 * mint on mainnet before writing, because approval is an attestation of identity and Jupiter
 * liquidity, volume or popularity must never grant it. Re-running for the same mint updates that row.
 *
 *   tsx --env-file-if-exists=backend/.env backend/scripts/approve-rwa.mts --confirm
 */

const TOKEN_PROGRAMS = ['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb']

/** The genuine Backed xStock. Every other `NVDAx` symbol on Solana is an unrelated imitation. */
const NVDAX: RWAAsset = {
  mint: 'Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh',
  symbol: 'NVDAx',
  name: 'NVIDIA xStock',
  issuer: 'Backed Assets (xStocks)',
  category: 'EQUITY',
  underlying: 'NVDA',
  decimals: 8,
  verified: true,
  allowedForSwap: true,
  verificationSource: 'https://jup.ag/token/Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh',
  updatedAt: new Date().toISOString(),
}

const candidate = rwaAssetSchema.parse(NVDAX)
// Same default as RWARegistry, so this checks the exact endpoint the backend would use.
const rpc = new Connection(process.env.RWA_SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com', 'confirmed')

console.log('rpc endpoint     :', rpc.rpcEndpoint)
let genesis = ''
try { genesis = await rpc.getGenesisHash() }
catch (error) { throw new Error(`RPC unreachable at ${rpc.rpcEndpoint}: ${error instanceof Error ? error.message : error}`) }
if (genesis !== MAINNET_GENESIS) throw new Error(`RWA approval requires mainnet; genesis was ${genesis}.`)
const account = (await rpc.getParsedAccountInfo(new PublicKey(candidate.mint))).value
if (!account) throw new Error(`Mint ${candidate.mint} does not exist on mainnet.`)
if (!TOKEN_PROGRAMS.includes(account.owner.toBase58())) throw new Error(`Mint ${candidate.mint} is not an SPL mint (owner ${account.owner.toBase58()}).`)
const parsed = account.data
if (!('parsed' in parsed) || parsed.parsed.type !== 'mint') throw new Error(`Mint ${candidate.mint} has no parsed mint data.`)
if (parsed.parsed.info.decimals !== candidate.decimals) throw new Error(`Decimals mismatch: chain ${parsed.parsed.info.decimals}, record ${candidate.decimals}.`)
if (parsed.parsed.info.isInitialized !== true) throw new Error(`Mint ${candidate.mint} is not initialized.`)
console.log('on-chain check   : OK', candidate.mint, 'decimals', candidate.decimals, 'program', account.owner.toBase58())

if (!process.argv.includes('--confirm')) {
  console.log('dry run          : pass --confirm to write this approval')
  process.exit(0)
}
if (storageMode() === 'mongo') {
  const collection = (await mongoDatabase.get()).collection(RWA_APPROVED_LIST)
  await collection.updateOne({ mint: candidate.mint }, { $set: { ...candidate, mint: candidate.mint } }, { upsert: true })
  await collection.createIndex({ mint: 1 }, { unique: true })
  console.log('approved (mongo) :', await collection.countDocuments(), 'row(s) in', RWA_APPROVED_LIST)
} else {
  const path = process.env.RWA_APPROVED_LIST_PATH || process.env.RWA_REGISTRY_PATH
  if (!path) throw new Error('Set RWA_APPROVED_LIST_PATH for the file store.')
  const { readFile, writeFile } = await import('node:fs/promises')
  const existing: unknown[] = await readFile(path, 'utf8').then(text => JSON.parse(text)).catch(() => [])
  const merged = [...existing.filter(row => (row as RWAAsset).mint !== candidate.mint), candidate]
  await writeFile(path, JSON.stringify(merged, null, 2))
  console.log('approved (file)  :', merged.length, 'row(s) in', path)
}
process.exit(0)
