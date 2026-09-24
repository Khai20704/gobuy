import { useEffect, useRef, useState, type FormEvent } from 'react'
import { AuthorityPanel } from './components/AuthorityPanel'
import { evaluate, type Mandate, type Message, type Proposal, type RecordItem } from './domain/types'
import { discoverDemo } from './services/demoAgent'
import './na.css'

type Tab = 'conversation' | 'mandate' | 'activity'
export function NaWorkspacePage() {
  const [tab, setTab] = useState<Tab>('conversation')
  const [mandate, setMandate] = useState<Mandate>({ limit: 200, requireVerified: true, autonomy: true, version: 1 })
  const [messages, setMessages] = useState<Message[]>([])
  const [text, setText] = useState('')
  const [attachment, setAttachment] = useState('')
  const [error, setError] = useState('')
  const [pending, setPending] = useState(false)
  const [proposal, setProposal] = useState<Proposal | null>(null)
  const [records, setRecords] = useState<RecordItem[]>([])
  const [scenario, setScenario] = useState<'within' | 'outside'>('within')
  const fileInput = useRef<HTMLInputElement>(null)
  const bottom = useRef<HTMLDivElement>(null)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => { bottom.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }) }, [messages, pending, proposal])
  async function submit(event: FormEvent) {
    event.preventDefault()
    if (pending || (!text.trim() && !attachment)) return
    setMessages(current => [...current, { id: crypto.randomUUID(), text: text.trim() || 'Explore this reference image', image: attachment || undefined }])
    setText(''); setAttachment(''); setProposal(null); setPending(true)
    try {
      const result = await discoverDemo(scenario)
      if (!mounted.current) return
      setProposal(result)
      const approved = evaluate(result, mandate).every(check => check.passed)
      setRecords(current => [{ id: result.id, title: result.title, approved, version: mandate.version, time: new Date().toLocaleTimeString() }, ...current])
    } catch { if (mounted.current) setError('The demo could not finish. Please try again.') }
    finally { if (mounted.current) setPending(false) }
  }
  function updateMandate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const values = new FormData(event.currentTarget)
    const limit = Number(values.get('limit'))
    if (!Number.isSafeInteger(limit) || limit < 1) return
    setMandate(current => ({ limit, requireVerified: values.has('verified'), autonomy: values.has('autonomy'), version: current.version + 1 }))
    setProposal(null); setTab('conversation')
  }
  return <div className="na-app">
    <aside className="rail"><a href="/na" className="wordmark">GoBuy<span>®</span></a><div className="workspace-label">PERSONAL WORKSPACE</div><nav aria-label="Workspace"><button aria-label="Talk to Na" className={tab === 'conversation' ? 'active' : ''} onClick={() => setTab('conversation')}>✳ <span>Talk to Na</span><span className="nav-dot"/></button><button aria-label="My mandate" disabled={pending} className={tab === 'mandate' ? 'active' : ''} onClick={() => setTab('mandate')}>◇ <span>My mandate</span></button><button aria-label="Activity" className={tab === 'activity' ? 'active' : ''} onClick={() => setTab('activity')}>◷ <span>Activity</span><small>{records.length || ''}</small></button></nav><div className="rail-story"><span>INTELLIGENCE MEETS<br/>YOUR AUTHORITY.</span><div className="orbit-art">✳</div><p>A little autonomy.<br/>Exactly your boundaries.</p></div><div className="rail-bottom"><span className="profile">K</span><div><strong>Your workspace</strong><small>Local preview</small></div><span>⌘</span></div></aside>
    <main className="workspace"><header className="workspace-header"><div><span className="breadcrumb">Workspace</span><span className="slash">/</span><strong>{tab === 'conversation' ? 'Talk to Na' : tab === 'mandate' ? 'My mandate' : 'Activity'}</strong></div><div className="header-status"><span className="preview-tag">● UI PREVIEW</span><span className="wallet-status">Wallet not connected</span></div></header><div className="workspace-body"><section className="conversation">
      {tab === 'conversation' && <><div className="conversation-heading"><span className="eyeline">YOUR PERSONAL COMMERCE AUTHORITY</span><h1>A thought. A request.<br/><em>Na takes it from here.</em></h1><p>Tell Na what you have in mind. Your rules stay in charge.</p></div><div className="conversation-feed" aria-live="polite"><div className="na-message"><span className="na-avatar">na<span>·</span></span><div><div className="message-meta">Na <span>YOUR AUTHORITY</span></div><p>What would you like to find today? Describe an item or add a reference image. I’ll bring the proposal back to your boundaries.</p></div></div>{messages.length === 0 && <div className="prompt-grid">{['Find a minimal digital artwork', 'Check whether a proposal fits my rules'].map((prompt, i) => <button key={prompt} onClick={() => setText(prompt)}><span>{i === 0 ? '✧' : '◇'}</span><strong>{prompt}</strong><small>{i === 0 ? 'Start with an idea' : 'Put your mandate to work'} ↗</small></button>)}</div>}{messages.map(message => <div className="user-message" key={message.id}>{message.image && <img src={message.image} alt="Your reference"/>}<p>{message.text}</p></div>)}{pending && <div className="progress-message"><span className="spinner"/> Preparing sample proposal, then checking your mandate…</div>}{proposal && <div className="na-message"><span className="na-avatar">na<span>·</span></span><div className="response"><div className="message-meta">Na <span>PROPOSAL RECEIVED</span></div><p>The demo agent returned this sample. The authority panel shows how it meets your current rules.</p><article className="proposal-card"><div className="artwork"><span className="art-orb"/><i/><b>STUDY / 008</b></div><div className="proposal-details"><span className="eyeline">ILLUSTRATIVE DIGITAL ARTWORK</span><h3>{proposal.title}</h3><p>Sample source · Verified fixture</p><div><strong>{proposal.amount} <small>demo units</small></strong><span className="sample-tag">SAMPLE</span></div></div></article><p className="fixture-note">Fixed sample; your message and image are not analyzed in this UI build.</p></div></div>}<div ref={bottom}/></div><form className="composer" onSubmit={submit}>{attachment && <div className="attachment"><img src={attachment} alt="Attached reference"/><span>Reference image</span><button type="button" onClick={() => setAttachment('')} aria-label="Remove image">×</button></div>}<label className="sr-only" htmlFor="request">Your request to Na</label><textarea id="request" value={text} onChange={event => setText(event.target.value)} placeholder="Tell Na what you're looking for…" rows={2} disabled={pending}/><div className="composer-tools"><div><button type="button" className="attach-button" onClick={() => fileInput.current?.click()} disabled={pending}>＋ <span>Add image</span></button><label className="scenario-label">Demo scenario <select aria-label="Demo scenario" value={scenario} onChange={event => setScenario(event.target.value as 'within' | 'outside')} disabled={pending}><option value="within">Within budget</option><option value="outside">Over budget</option></select></label></div><button className="send-button" type="submit" disabled={pending || (!text.trim() && !attachment)} aria-label="Send request">↑</button></div><input ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (!file) return; if (!['image/png','image/jpeg','image/webp'].includes(file.type) || file.size > 5 * 1024 * 1024) { setError('Choose a PNG, JPG or WebP image under 5 MB.'); return } setError(''); const reader = new FileReader(); reader.onload = () => { if (typeof reader.result === 'string' && mounted.current) setAttachment(reader.result) }; reader.onerror = () => setError('Could not read this image.'); reader.readAsDataURL(file) }}/></form>{error && <p role="alert" className="error-text">{error}</p>}<div className="composer-caption">Private local preview · Images stay in this browser session</div></>}
      {tab === 'mandate' && <div className="settings-page"><span className="eyeline">YOUR RULES COME FIRST</span><h1>Define your<br/><em>boundaries.</em></h1><p className="muted">Changes apply to this browser session. On-chain signing is a later integration.</p><form onSubmit={updateMandate} className="mandate-form"><label>Maximum proposal value <input name="limit" type="number" min="1" max="1000000" step="1" defaultValue={mandate.limit} required/><small>Demo units · no monetary value</small></label><label className="toggle-row"><span><strong>Require verified source</strong><small>Reject proposals without source evidence.</small></span><input name="verified" type="checkbox" defaultChecked={mandate.requireVerified}/></label><label className="toggle-row"><span><strong>Autonomous authorization</strong><small>Allow proposals within your rules to pass.</small></span><input name="autonomy" type="checkbox" defaultChecked={mandate.autonomy}/></label><button className="primary" type="submit">Save demo mandate ↗</button></form></div>}
      {tab === 'activity' && <div className="settings-page"><span className="eyeline">A CLEAR RECORD</span><h1>Every decision.<br/><em>In the open.</em></h1><p className="muted">Session history · local checks only. No transaction signatures have been created.</p>{!records.length ? <div className="empty-history">◎<h3>Your story starts with a request.</h3><button className="outline" onClick={() => setTab('conversation')}>Talk to Na →</button></div> : <div className="history-list">{records.map(record => <article key={record.id}><div><strong>{record.title}</strong><small>Mandate v{record.version} · {record.time}</small></div><span className={record.approved ? 'good' : 'bad'}>{record.approved ? 'Approved' : 'Rejected'}</span></article>)}</div>}</div>}
    </section><AuthorityPanel mandate={mandate} proposal={proposal} onEdit={() => { if (!pending) setTab('mandate') }}/></div><footer className="workspace-footer"><span>GoBuy / Built around your authority.</span><span>UI prototype · No live AI or on-chain connection</span></footer></main>
  </div>
}
