import { Transaction, TransactionInstruction, VersionedTransaction, type Connection } from '@solana/web3.js'
import { devnetConnection, requireDevnet } from './network'

export function logNaVaultSignatureSlots(transaction: Transaction, trace: string, stage: string) {
  console.log(`[NaVault debug ${trace}] ${stage} signatures\n` + JSON.stringify(transaction.signatures.map(({ publicKey, signature }) => ({
    publicKey: publicKey.toBase58(),
    state: signature === null ? 'null' : signature.every(byte => byte === 0) ? 'all-zero' : 'populated',
    byteLength: signature?.length ?? 0,
  })), null, 2))
}

export function cleanNaVaultTransaction(original: Transaction, trace: string) {
  logNaVaultSignatureSlots(original, trace, 'backend-deserialized')
  if (original.nonceInfo) throw new Error('Expected a recent-blockhash transaction, not a durable nonce transaction.')
  const clean = new Transaction({ feePayer: original.feePayer, recentBlockhash: original.recentBlockhash })
  clean.add(...original.instructions.map(instruction => new TransactionInstruction({
    programId: instruction.programId,
    keys: instruction.keys.map(key => ({ ...key })),
    data: instruction.data.slice(),
  })))
  const originalMessage = original.serializeMessage()
  const cleanMessage = clean.serializeMessage()
  const identical = originalMessage.equals(cleanMessage)
  console.log(`[NaVault debug ${trace}] clean message comparison\n` + JSON.stringify({
    identical, originalMessageHex: originalMessage.toString('hex'), cleanMessageHex: cleanMessage.toString('hex'),
  }, null, 2))
  if (!identical) throw new Error('Clean transaction message differs from backend transaction; signing blocked.')
  // serializeMessage may create null signer slots. Remove them for this isolated experiment.
  clean.signatures = []
  logNaVaultSignatureSlots(clean, trace, 'clean constructed')
  return clean
}

/** Temporary Na Vault diagnostics. Never pass wallet providers, keypairs or backend config here. */
export function deserializeNaVaultTransaction(encoded: string, trace: string) {
  const bytes = Uint8Array.from(atob(encoded), char => char.charCodeAt(0))
  const wire = VersionedTransaction.deserialize(bytes)
  console.log(`[NaVault debug ${trace}] wire format`, wire.version)
  if (wire.version !== 'legacy') throw new Error(`Na Vault backend returned version ${wire.version}; expected legacy Transaction.`)
  return Transaction.from(bytes)
}

export async function diagnoseNaVaultTransaction(transaction: Transaction, trace: string, connectedPublicKey: string | null, connection: Connection = devnetConnection()) {
  const prefix = `[NaVault debug ${trace}]`
  const message = transaction.compileMessage()
  const requiredSigners = message.accountKeys.slice(0, message.header.numRequiredSignatures).map(key => key.toBase58())
  console.log(`${prefix} deserialized transaction`, transaction)
  console.log(`${prefix} transaction details\n` + JSON.stringify({
    transactionType: 'legacy Transaction',
    requiredSigners,
    connectedPhantomPublicKey: connectedPublicKey,
    connectedWalletIsRequiredSigner: connectedPublicKey !== null && requiredSigners.includes(connectedPublicKey),
    feePayer: transaction.feePayer?.toBase58() ?? null,
    recentBlockhash: transaction.recentBlockhash ?? null,
    instructions: transaction.instructions.map((instruction, index) => ({
      index, programId: instruction.programId.toBase58(),
      accounts: instruction.keys.map(key => ({
        publicKey: key.pubkey.toBase58(), isSigner: key.isSigner, isWritable: key.isWritable,
      })),
      dataHex: Array.from(instruction.data, byte => byte.toString(16).padStart(2, '0')).join(''),
    })),
  }, null, 2))
  try {
    await requireDevnet(connection)
    // Use the versioned overload with a legacy message: the legacy simulation overload
    // may replace the blockhash. This preserves the exact unsigned message Phantom receives.
    const copy = VersionedTransaction.deserialize(transaction.serialize({ requireAllSignatures: false, verifySignatures: false }))
    const simulation = await connection.simulateTransaction(copy, {
      commitment: 'confirmed', sigVerify: false, replaceRecentBlockhash: false,
    })
    console.log(`${prefix} simulation.value.err\n` + JSON.stringify(simulation.value.err, null, 2))
    console.log(`${prefix} simulation.value.logs\n` + JSON.stringify(simulation.value.logs, null, 2))
  } catch (error) {
    console.error(`${prefix} simulation.value.err: unavailable (RPC did not return a simulation result)`)
    console.error(`${prefix} simulation.value.logs: unavailable (RPC did not return a simulation result)`)
    logNaVaultSigningError(error, trace, 'simulation failure')
  }
}

export function logNaVaultSigningError(error: unknown, trace: string, stage = 'signing error') {
  // Error properties such as message, stack and cause are often non-enumerable.
  const seen = new WeakSet<object>()
  const snapshot = (value: unknown): unknown => {
    // Preserve transport failure messages without printing authenticated RPC URLs.
    if (typeof value === 'string') return value.replace(/https?:\/\/[^\s"'<>]+/gi, '[URL REDACTED]')
    if (!value || typeof value !== 'object') return typeof value === 'bigint' ? value.toString() : value
    if (seen.has(value)) return '[Circular]'
    seen.add(value)
    if (Array.isArray(value)) return value.map(snapshot)
    return Object.fromEntries(Object.getOwnPropertyNames(value).map(key => {
      if (/private.?key|secret|seed|mnemonic|api.?key|authorization|access.?token/i.test(key)) return [key, '[REDACTED]']
      try { return [key, snapshot(Reflect.get(value, key))] } catch { return [key, '[Unreadable]'] }
    }))
  }
  const details = snapshot(error)
  console.error(`[NaVault debug ${trace}] ${stage} object (secret fields redacted)`, details)
  console.error(`[NaVault debug ${trace}] ${stage} JSON\n` + JSON.stringify(details, null, 2))
}
