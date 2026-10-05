import { SystemProgram, Transaction, VersionedTransaction } from '@solana/web3.js'
import { devnetConnection, requireDevnet } from './network'
import { logNaVaultSigningError } from './naVaultDiagnostics'

/** Temporary manual A/B probe. Never returns signed bytes or broadcasts. */
export async function runPhantomIsolation(owner: string, connection = devnetConnection()) {
  const prefix = '[NaVault Phantom isolation]'
  const provider = window.phantom?.solana
  if (!provider?.isPhantom || typeof provider.signTransaction !== 'function' || provider.publicKey?.toBase58() !== owner) {
    throw new Error('Connected window.phantom.solana provider does not match the selected wallet.')
  }
  await requireDevnet(connection)
  const connectedWallet = provider.publicKey
  const latestBlockhash = await connection.getLatestBlockhash('confirmed')
  const testTransaction = new Transaction()
  testTransaction.feePayer = connectedWallet
  testTransaction.recentBlockhash = latestBlockhash.blockhash
  testTransaction.add(SystemProgram.transfer({ fromPubkey: connectedWallet, toPubkey: connectedWallet, lamports: 1 }))
  try {
    const copy = VersionedTransaction.deserialize(testTransaction.serialize({ requireAllSignatures: false, verifySignatures: false }))
    const simulation = await connection.simulateTransaction(copy, { commitment: 'confirmed', sigVerify: false, replaceRecentBlockhash: false })
    console.log(`${prefix} simulation.value.err\n` + JSON.stringify(simulation.value.err, null, 2))
    console.log(`${prefix} simulation.value.logs\n` + JSON.stringify(simulation.value.logs, null, 2))
  } catch (error) {
    console.error(`${prefix} simulation.value.err: unavailable; simulation.value.logs: unavailable`)
    logNaVaultSigningError(error, 'Phantom isolation', 'simulation failure')
    throw error
  }
  const message = testTransaction.compileMessage()
  testTransaction.signatures = []
  console.log(`${prefix} before signing\n` + JSON.stringify({
    transactionType: 'legacy Transaction', feePayer: testTransaction.feePayer.toBase58(),
    recentBlockhash: testTransaction.recentBlockhash,
    requiredSigners: message.accountKeys.slice(0, message.header.numRequiredSignatures).map(key => key.toBase58()),
    signatures: testTransaction.signatures, providerSource: 'window.phantom.solana',
    connectedPublicKey: provider.publicKey?.toBase58(),
  }, null, 2))
  if (window.phantom?.solana !== provider || provider.publicKey?.toBase58() !== owner) throw new Error('Phantom provider or account changed before isolation signing.')
  try {
    await window.phantom.solana.signTransaction(testTransaction)
    console.log(`${prefix} SIMPLE_SIGN_SUCCESS`)
    console.log(`${prefix} B) Simple SystemProgram transaction signs successfully => Phantom/provider works; failure is specific to CreateMandate presented to Phantom. No transaction broadcast.`)
    return 'B' as const
  } catch (error) {
    console.error(`${prefix} SIMPLE_SIGN_FAILED`)
    logNaVaultSigningError(error, 'Phantom isolation', 'SIMPLE_SIGN_FAILED')
    const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
    if (code === -32603) {
      console.log(`${prefix} A) Simple SystemProgram transaction also fails with -32603 => Phantom/provider/environment integration problem, not specific to GoBuy CreateMandate. No transaction broadcast.`)
      return 'A' as const
    }
    // Rejection, pending requests and other errors do not establish the requested A/B result.
    throw error
  }
}
