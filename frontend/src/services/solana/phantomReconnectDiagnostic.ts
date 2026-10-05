import { SystemProgram, Transaction, VersionedTransaction } from '@solana/web3.js'
import { devnetConnection, requireDevnet } from './network'
import { logNaVaultSigningError } from './naVaultDiagnostics'
import type { PhantomProvider } from './phantom'

// Only inspect specific public metadata; never dump the provider/session object.
function metadata(provider: PhantomProvider | undefined) {
  const optional = (key: string) => {
    try {
      const value: unknown = provider && Reflect.get(provider, key)
      return ['string', 'number', 'boolean'].includes(typeof value) ? value : 'not exposed'
    } catch { return 'unreadable' }
  }
  return {
    isPhantom: provider?.isPhantom ?? null,
    isConnected: optional('isConnected'),
    publicKey: provider?.publicKey?.toBase58() ?? null,
    // Best-effort metadata only; never used to choose signing behavior.
    version: optional('version'), phantomVersion: optional('phantomVersion'),
  }
}

/** Temporary, explicitly invoked session reset and sign-only diagnostic. */
export async function runPhantomReconnectDiagnostic(connection = devnetConnection()) {
  const prefix = '[NaVault Phantom reconnect]'
  let stage = 'provider inspection'
  try {
    const provider = window.phantom?.solana
    console.log(`${prefix} providers before reconnect\n` + JSON.stringify({
      'window.phantom.solana': metadata(provider),
      'window.solana': metadata(window.solana),
      sameProvider: window.solana === provider,
    }, null, 2))
    if (!provider?.isPhantom) throw new Error('window.phantom.solana is unavailable.')
    stage = 'disconnect'
    await provider.disconnect()
    stage = 'connect'
    const response = await provider.connect()
    const owner = response.publicKey
    console.log(`${prefix} connect response.publicKey`, owner.toBase58())
    console.log(`${prefix} provider after reconnect\n` + JSON.stringify(metadata(provider), null, 2))
    stage = 'Devnet transaction preparation'
    await requireDevnet(connection)
    const latestBlockhash = await connection.getLatestBlockhash('confirmed')
    const transaction = new Transaction()
    transaction.feePayer = owner
    transaction.recentBlockhash = latestBlockhash.blockhash
    transaction.add(SystemProgram.transfer({ fromPubkey: owner, toPubkey: owner, lamports: 1 }))
    stage = 'simulation'
    const copy = VersionedTransaction.deserialize(transaction.serialize({ requireAllSignatures: false, verifySignatures: false }))
    const simulation = await connection.simulateTransaction(copy, { commitment: 'confirmed', sigVerify: false, replaceRecentBlockhash: false })
    console.log(`${prefix} simulation.value.err\n` + JSON.stringify(simulation.value.err, null, 2))
    console.log(`${prefix} simulation.value.logs\n` + JSON.stringify(simulation.value.logs, null, 2))
    const message = transaction.compileMessage()
    transaction.signatures = []
    console.log(`${prefix} before signing\n` + JSON.stringify({
      transactionType: 'legacy Transaction', feePayer: owner.toBase58(),
      recentBlockhash: transaction.recentBlockhash,
      requiredSigners: message.accountKeys.slice(0, message.header.numRequiredSignatures).map(key => key.toBase58()),
      signatures: transaction.signatures, providerSource: 'window.phantom.solana (same captured instance)',
    }, null, 2))
    stage = 'provider/account check'
    if (window.phantom?.solana !== provider || provider.publicKey?.toBase58() !== owner.toBase58()) throw new Error('Provider/account changed after reconnect.')
    stage = 'signTransaction'
    await provider.signTransaction(transaction)
    console.log(`${prefix} PHANTOM_RECONNECT_SIGN_SUCCESS`)
    return true
  } catch (error) {
    console.error(`${prefix} PHANTOM_RECONNECT_SIGN_FAILED`, { stage })
    if (stage === 'simulation') console.error(`${prefix} simulation.value.err / simulation.value.logs unavailable: RPC failed`)
    logNaVaultSigningError(error, 'Phantom reconnect', 'PHANTOM_RECONNECT_SIGN_FAILED')
    return false
  }
}
