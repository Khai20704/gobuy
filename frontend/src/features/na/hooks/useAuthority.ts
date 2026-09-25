import { useCallback, useEffect, useRef, useState } from 'react'
import { DEFAULT_MANDATE, type Mandate, type MandateInput, type CommerceProposal, type AuditRecord } from '@gobuy/shared'
import type { NaClient } from '../../../services/solana/client'
import { findPhantomProvider, phantomProvider, PhantomUnavailableError, type PhantomProvider } from '../../../services/solana/phantom'
import { UnconfirmedTransactionError } from '../../../services/solana/confirmation'

export function useAuthority() {
  const [wallet, setWallet] = useState('')
  const [client, setClient] = useState<NaClient | null>(null)
  const [mandate, setMandate] = useState<Mandate>(DEFAULT_MANDATE)
  const [hasMandate, setHasMandate] = useState(false)
  const [records, setRecords] = useState<AuditRecord[]>([])
  const [result, setResult] = useState<AuditRecord | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [walletHelp, setWalletHelp] = useState(false)
  const [pendingSignature, setPendingSignature] = useState('')
  const [setup, setSetup] = useState('You can connect Phantom now. Proposals are demo data; on-chain verification needs a deployed Devnet program.')
  const epoch = useRef(0)
  const locked = useRef(false)
  const subscribed = useRef<PhantomProvider | undefined>(undefined)
  const unsubscribe = useRef<() => void>(() => {})
  const reset = useCallback(() => {
      epoch.current++; locked.current = false
      setWallet(''); setClient(null); setHasMandate(false); setRecords([]); setResult(null)
      setMandate(DEFAULT_MANDATE); setBusy(false); setPendingSignature(''); setError('')
      setSetup('Wallet changed or disconnected. Reconnect to load its Devnet mandate.')
  }, [])
  const subscribe = useCallback((provider: PhantomProvider) => {
    if (subscribed.current === provider) return
    unsubscribe.current()
    subscribed.current = provider
    provider?.on('accountChanged', reset); provider?.on('disconnect', reset)
    unsubscribe.current = () => { provider.removeListener('accountChanged', reset); provider.removeListener('disconnect', reset) }
  }, [reset])
  useEffect(() => {
    const provider = findPhantomProvider()
    if (provider) subscribe(provider)
    return () => { epoch.current++; unsubscribe.current(); subscribed.current = undefined }
  }, [subscribe])
  const run = useCallback(async (action: (token: number) => Promise<void>) => {
    if (locked.current) return
    locked.current = true
    const token = epoch.current
    setBusy(true); setError(''); setPendingSignature(''); setWalletHelp(false)
    try { await action(token) }
    catch (cause) {
      if (token !== epoch.current) return
      setError(cause instanceof Error ? cause.message : 'Request failed.')
      if (cause instanceof PhantomUnavailableError) setWalletHelp(true)
      if (cause instanceof UnconfirmedTransactionError) setPendingSignature(cause.signature)
    } finally { if (token === epoch.current) { locked.current = false; setBusy(false) } }
  }, [])
  function connect() { return run(async token => {
    setResult(null)
    const provider = await phantomProvider()
    if (token !== epoch.current) return
    subscribe(provider)
    const connected = await provider.connect()
    if (token !== epoch.current) return
    setWallet(connected.publicKey.toBase58())
    if (!import.meta.env.VITE_SOLANA_PROGRAM_ID?.trim()) {
      setClient(null); setHasMandate(false); setRecords([])
      setSetup('Wallet connected. On-chain verification is not set up yet. You can continue using demo proposals and demo boundaries.')
      return
    }
    try {
      const { NaClient } = await import('../../../services/solana/client')
      const next = await NaClient.create(provider)
      const current = await next.fetchMandate()
      const history = await next.history()
      if (token !== epoch.current) return
      setClient(next); setHasMandate(!!current); setMandate(current ?? DEFAULT_MANDATE)
      setRecords(history); setSetup(current ? 'Connected to Solana Devnet. Authority comes from the program state.' : 'Devnet program ready. Create your mandate with Phantom.')
    } catch (cause) {
      if (token !== epoch.current) return
      setClient(null); setHasMandate(false); setRecords([]); setResult(null); setMandate(DEFAULT_MANDATE)
      setSetup('Wallet connected. ' + (cause instanceof Error ? cause.message : 'Devnet setup incomplete.'))
    }
  }) }
  function disconnect() { return run(async () => {
    await subscribed.current?.disconnect()
    reset()
    setSetup('Wallet disconnected. Demo proposals remain available.')
  }) }
  function save(input: MandateInput) { return run(async token => {
    setResult(null)
    if (!client) { setMandate(current => ({ ...input, version: current.version + 1 })); return }
    const saved = await client.saveMandate(input, hasMandate ? mandate.version : null)
    if (token !== epoch.current) return
    setMandate(saved.mandate); setHasMandate(true)
    setSetup('Mandate confirmed on Devnet. Transaction: ' + saved.signature)
  }) }
  function authorize(proposal: CommerceProposal) { return run(async token => {
    if (!client || !hasMandate) throw new Error('Create a Devnet mandate before verifying.')
    setResult(null)
    const record = await client.authorize(proposal, mandate.version)
    if (token !== epoch.current) return
    setResult(record); setRecords(current => [record, ...current.filter(item => item.address !== record.address)])
  }) }
  function refresh() { return run(async token => {
    if (!client) return
    const [current, history] = await Promise.all([client.fetchMandate(), client.history()])
    if (token !== epoch.current) return
    setMandate(current ?? DEFAULT_MANDATE); setHasMandate(!!current); setRecords(history); setResult(null)
  }) }
  return { wallet, client, mandate, hasMandate, records, result, busy, error, walletHelp, pendingSignature,
    setup, connect, disconnect, save, authorize, refresh, clearResult: () => setResult(null) }
}
