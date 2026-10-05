import { useEffect, useRef, useState, type FormEvent } from 'react'
import { researchResponseSchema, type ResearchResponse, type PageContext, type ActionLog, type PurchaseIntent } from '@gobuy/shared'
import { actions, message, readPage, search, resumeSearch } from './lib/agent'
import './chat.css'

export function Chat({ panel = false }: { panel?: boolean }) {
  const [text, setText] = useState(''), [code, setCode] = useState(''), [connected, setConnected] = useState(false)
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [result, setResult] = useState<ResearchResponse>()
  const [context, setContext] = useState<PageContext>(), [history, setHistory] = useState<ActionLog[]>([])
  const [structured, setStructured] = useState(false), [asset, setAsset] = useState<PurchaseIntent['assetType']>('PHYSICAL')
  const [budget, setBudget] = useState(''), [currency, setCurrency] = useState('USD'), [collection, setCollection] = useState('')
  const lock = useRef(false)
  useEffect(() => {
    void message('state').then(state => setConnected(!!(state as { connected: boolean }).connected)).catch(() => {})
    void chrome.storage.session.get('conversation').then(value => {
      const parsed = researchResponseSchema.safeParse(value.conversation)
      if (parsed.success) setResult(parsed.data)
    })
    void chrome.storage.session.get('pendingJob').then(value => {
      if (typeof value.pendingJob === 'string') void run(async () => setResult(await resumeSearch(value.pendingJob as string)))
    })
  }, [])
  async function run(action: () => Promise<void>) {
    if (lock.current) return
    lock.current = true; setBusy(true); setError('')
    try { await action() } catch (e) { setError(e instanceof Error ? e.message : 'Na is unavailable.') }
    finally { lock.current = false; setBusy(false) }
  }
  async function submit(event?: FormEvent, page?: PageContext) {
    event?.preventDefault()
    await run(async () => {
      const requestText = text.trim() || (page ? 'Analyze this listing using independent sources.' : '')
      const intent: PurchaseIntent | undefined = structured && !page ? { requestId: crypto.randomUUID(), assetType: asset, query: requestText,
        ...(budget !== '' ? { budget: { amount: Number(budget), currency } } : {}),
        preferences: { ...(collection ? { collectionSymbol: collection } : {}) } } : undefined
      const response = await search(requestText, intent, page)
      setResult(response); await chrome.storage.session.set({ conversation: response })
    })
  }
  return <main className={panel ? 'chat panel' : 'chat'}>
    <header><div className="mark">na<span>·</span></div><div><h1>Commerce Agent</h1><small>Research. Verify. Review.</small></div></header>
    <nav><button onClick={() => void run(async () => { await message('openWeb') })}>Phantom & policy</button>
      {!panel && <button onClick={() => { void chrome.windows.getCurrent().then(w => w.id === undefined ? undefined : chrome.sidePanel.open({ windowId: w.id })).catch(() => setError('Use Chrome’s side panel menu to open Na.')) }}>Open side panel</button>}
      {connected && <button onClick={() => void run(async () => { await message('disconnect'); setConnected(false); setResult(undefined); setHistory([]) })}>Disconnect</button>}</nav>
    {!connected ? <section><h2>Connect to GoBuy</h2><p>Open Phantom & policy, generate a pairing code, and paste it here. No wallet key is requested.</p>
      <form onSubmit={e => { e.preventDefault(); void run(async () => { await message('pair', { code: code.trim() }); setConnected(true); setCode('') }) }}>
        <label>One-time pairing code<input value={code} onChange={e => setCode(e.target.value)} required maxLength={32} autoComplete="off"/></label>
        <button className="primary" disabled={busy}>Connect</button></form></section> : <>
      <section><button disabled={busy} onClick={() => void run(async () => setContext(await readPage()))}>Inspect current page</button>
        {context && <div className="page-context"><small>UNTRUSTED PAGE · {new URL(context.url).hostname}</small><p>{context.title}</p>
          {context.collectionSymbol && <p>Collection: {context.collectionSymbol}</p>}{context.priceText && <p>Page price claim: {context.priceText}</p>}
          <button disabled={busy} onClick={() => void submit(undefined, context)}>Analyze with Na</button></div>}</section>
      <form onSubmit={e => void submit(e)}><label>Your request<textarea value={text} onChange={e => setText(e.target.value)} maxLength={2000} required rows={3} placeholder="Find Jordan 1 under $200"/></label>
        <label className="check"><input type="checkbox" checked={structured} onChange={e => setStructured(e.target.checked)}/>Use structured search (no AI required)</label>
        {structured && <div className="filters"><label>Asset<select value={asset} onChange={e => setAsset(e.target.value as PurchaseIntent['assetType'])}><option value="PHYSICAL">Product</option><option value="NFT">NFT</option><option value="RWA">RWA</option></select></label>
          <label>Maximum for this request<input type="number" min="0" step="any" value={budget} onChange={e => setBudget(e.target.value)}/></label>
          <label>Currency<select value={currency} onChange={e => setCurrency(e.target.value)}>{['USD', 'USDC', 'SOL'].map(c => <option key={c}>{c}</option>)}</select></label>
          {asset === 'NFT' && <label>Magic Eden collection symbol<input value={collection} onChange={e => setCollection(e.target.value)} placeholder="mad_lads"/></label>}</div>}
        <button className="primary" disabled={busy || !text.trim()}>{busy ? 'Na is researching…' : 'Search with Na'}</button></form>
      {result && <section aria-live="polite"><small>AI: {result.ai ? result.ai.provider + (result.ai.fallback ? ' fallback' : '') : 'deterministic'} · {result.mode}</small>
        <h2>{result.status === 'SELECTED' ? 'Best valid match' : result.status.replaceAll('_', ' ')}</h2><p>{result.summary}</p>
        {result.recommendations.map(({ item, verification, explanation }) => <article key={item.id}><h3>{item.title}</h3><strong>{item.price} {item.currency}</strong><p>{explanation}</p>
          <p>{item.source} · {verification.confidence}</p><p>Na authorization: review required</p>
          <a href={item.productUrl} target="_blank" rel="noreferrer">View source ↗</a> <button onClick={() => void message('openWeb')}>Continue in GoBuy</button></article>)}
        <p>{result.nextStep}</p>{result.warnings.map(w => <p className="notice" key={w}>{w}</p>)}
        <details><summary>Source status</summary>{result.providers.map(p => <p key={p.provider}>{p.provider}: {p.status} · {p.count} results</p>)}</details></section>}
      <section><button disabled={busy} onClick={() => void run(async () => setHistory(await actions()))}>Load action history</button>
        {history.slice(0, 20).map(a => <article key={a.id}><small>{new Date(a.timestamp).toLocaleString()}</small><strong>{a.status}</strong><p>{a.request}</p><p>{a.asset} {a.price} {a.currency} · {a.provider}</p><p>{a.reason}</p></article>)}</section>
    </>}
    {error && <p role="alert" className="error">{error}</p>}
    <footer>Phantom signs in GoBuy. Na has no wallet private key. Research is not authorization.</footer>
  </main>
}
