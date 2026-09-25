import { useEffect, useRef, useState, type FormEvent } from 'react'
import { NavLink, useLocation, useNavigate } from 'react-router-dom'
import { MAX_IMAGE_BYTES, canonicalProposal, hex, formatAmount, previewRules, previewReason,
  type CommerceProposal, type SearchRequest } from '@gobuy/shared'
import { AuthorityPanel } from './components/AuthorityPanel'
import { MandateForm } from './components/MandateForm'
import { ActivityHistory, type DemoAudit } from './components/ActivityHistory'
import { useAuthority } from './hooks/useAuthority'
import type { Message } from './domain/types'
import { discover } from '../../services/api/client'
import { explorerTx } from '../../services/solana/links'
import './na.css'

export function NaWorkspacePage() {
  const location = useLocation()
  const navigate = useNavigate()
  const tab = location.pathname.endsWith('/mandate') ? 'mandate' : location.pathname.endsWith('/activity') ? 'activity' : 'conversation'
  const authority = useAuthority()
  const [messages, setMessages] = useState<Message[]>([])
  const [text, setText] = useState('')
  const [attachment, setAttachment] = useState('')
  const [error, setError] = useState('')
  const [pending, setPending] = useState(false)
  const [proposal, setProposal] = useState<CommerceProposal | null>(null)
  const [demos, setDemos] = useState<DemoAudit[]>([])
  const [scenario, setScenario] = useState<SearchRequest['scenario']>('within')
  const fileInput = useRef<HTMLInputElement>(null)
  const mounted = useRef(true)
  const requestLock = useRef(false)
  const feed = useRef<HTMLDivElement>(null)
  useEffect(() => { if (feed.current) feed.current.scrollTop = feed.current.scrollHeight }, [messages, pending, proposal])
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const busy = pending || authority.busy

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (requestLock.current || busy || (!text.trim() && !attachment)) return
    requestLock.current = true
    const image = attachment ? { mimeType: attachment.slice(5, attachment.indexOf(';')) as 'image/png' | 'image/jpeg' | 'image/webp', base64: attachment.split(',')[1] } : undefined
    setMessages(current => [...current, { id: crypto.randomUUID(), text: text.trim() || 'Explore this reference image', image: attachment || undefined }])
    setPending(true); setError(''); setProposal(null); authority.clearResult()
    try {
      const response = await discover({ text: text.trim(), image, scenario })
      if (!mounted.current) return
      setProposal(response.proposals[0]); setText(''); setAttachment('')
    } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : 'Discovery failed.') }
    finally { requestLock.current = false; if (mounted.current) setPending(false) }
  }
  async function demoPreview() {
    if (!proposal) return
    const digest = await canonicalProposal(proposal)
    const reason = previewReason(previewRules(proposal, authority.mandate))
    setDemos(current => [{ id: crypto.randomUUID(), hash: hex(digest.hash), version: authority.mandate.version,
      reason: reason === 'APPROVED' ? 'RULES_MATCH' : reason, time: new Date().toLocaleTimeString() }, ...current])
    navigate('/na/activity')
  }
  return <div className="na-app">
    <aside className="rail">
      <NavLink to="/na" className="wordmark">GoBuy<span>®</span></NavLink><div className="workspace-label">PERSONAL WORKSPACE</div>
      <nav aria-label="Workspace">
        <NavLink end to="/na" aria-label="Talk to Na">✳ <span>Talk to Na</span><span className="nav-dot"/></NavLink>
        <NavLink to="/na/mandate" aria-label="My mandate">◇ <span>My mandate</span></NavLink>
        <NavLink to="/na/activity" aria-label="Activity">◷ <span>Activity</span><small>{authority.records.length + demos.length || ''}</small></NavLink>
      </nav>
      <div className="rail-story"><span>INTELLIGENCE MEETS<br/>YOUR AUTHORITY.</span><div className="orbit-art">✳</div><p>A little autonomy.<br/>Exactly your boundaries.</p></div>
      <div className="rail-bottom"><span className="profile">N</span><div><strong>Your workspace</strong><small>Devnet only</small></div></div>
    </aside>
    <main className="workspace">
      <header className="workspace-header"><div><span className="breadcrumb">Workspace</span><span className="slash">/</span><strong>{tab === 'conversation' ? 'Talk to Na' : tab === 'mandate' ? 'My mandate' : 'Activity'}</strong></div>
        <div className="header-status"><span className="preview-tag">● {authority.client ? 'DEVNET' : 'DEMO MODE'}</span>
          <button className="wallet-status" title={authority.wallet || undefined} disabled={busy} onClick={() => void authority.connect()}>{authority.wallet ? 'Connected: ' + authority.wallet.slice(0, 4) + '…' + authority.wallet.slice(-4) : 'Connect Phantom'}</button>
          {authority.wallet && <button className="wallet-status" disabled={busy} onClick={() => void authority.disconnect()}>Disconnect</button>}
        </div>
      </header>
      <div className="setup-banner" role="status">{authority.setup}</div>
      {(error || authority.error) && <div className="status-banner error-text" role="alert">{error || authority.error}
        {authority.pendingSignature && <a className="transaction-link" href={explorerTx(authority.pendingSignature)} target="_blank" rel="noreferrer">Inspect submitted transaction: {authority.pendingSignature} ↗</a>}
      </div>}
      {authority.walletHelp && <div className="setup-banner">
        <strong>Connect Phantom on this computer</strong>
        <ol>
          <li>Install or enable the Phantom extension in the Chrome profile you are using now.</li>
          <li>Open the extension and unlock it. Check that it is allowed to run on this site.</li>
          <li>Reload this localhost page, then click Connect Phantom and approve the connection in the extension.</li>
        </ol>
        <a href="https://phantom.com/" target="_blank" rel="noreferrer">Get Phantom from the official website ↗</a>
        <p>Connecting only shares your public address. It does not require a deployed GoBuy program or authorize a purchase.</p>
      </div>}
      <div className="workspace-body"><section className="conversation">
        {tab === 'conversation' && <>
          <div className="conversation-heading"><span className="eyeline">YOUR PERSONAL COMMERCE AUTHORITY</span><h1>A thought. A request.<br/><em>Na takes it from here.</em></h1><p>Tell Na what you have in mind. Your rules stay in charge.</p></div>
          <div ref={feed} className="conversation-feed" aria-live="polite">
            <div className="na-message"><span className="na-avatar">na<span>·</span></span><div><div className="message-meta">Na <span>YOUR AUTHORITY</span></div><p>Describe an item or add a reference image. The agent proposes; your signed mandate defines what Na can authorize.</p></div></div>
            {!messages.length && <div className="prompt-grid">{['Find a minimal digital artwork', 'Check a proposal against my boundaries'].map((prompt, index) => <button key={prompt} onClick={() => setText(prompt)}><span>{index ? '◇' : '✧'}</span><strong>{prompt}</strong><small>Start with an idea ↗</small></button>)}</div>}
            {messages.map(message => <div className="user-message" key={message.id}>{message.image && <img src={message.image} alt="Your reference"/>}<p>{message.text}</p></div>)}
            {pending && <div className="progress-message"><span className="spinner"/> Agent is finding a demo proposal through the API…</div>}
            {proposal && <div className="na-message"><span className="na-avatar">na<span>·</span></span><div className="response">
              <div className="message-meta">Agent proposal <span>DEMO DATA</span></div>
              <article className="proposal-card"><img className="proposal-art" src={proposal.metadata.imageUrl} alt={proposal.title}/><div className="proposal-details">
                <span className="eyeline">{proposal.assetType} · {proposal.marketplace}</span><h3>{proposal.title}</h3>
                <p>Source: mock adapter · Seller claim: {proposal.sellerEvidence.claimedVerified ? 'evidence present' : 'evidence missing'}</p>
                <div><strong>{formatAmount(proposal.amount)} <small>Devnet SOL</small></strong><span className="sample-tag">SAMPLE</span></div>
              </div></article>
              <p className="fixture-note">Asset: {proposal.assetId} · Evidence: {proposal.sellerEvidence.reference}</p>
              <p className="fixture-note">{proposal.sellerEvidence.disclaimer}</p>
              <p className="fixture-note">Mock agents return fixtures; they do not analyze your text or image. Expires {new Date(proposal.expiresAt * 1000).toLocaleTimeString()}.</p>
              {proposal.assetType === 'RWA' ? <p className="preview-summary">RWA data is read-only. No authorization or buying flow.</p> : authority.client
                ? <button className="primary proposal-action" disabled={busy || !authority.hasMandate || !!authority.result} onClick={() => void authority.authorize(proposal)}>{authority.busy ? 'Waiting for Phantom / Devnet…' : authority.result ? 'Decision recorded on Devnet' : authority.hasMandate ? 'Send proposal to Na · sign in Phantom ↗' : 'Create a mandate first'}</button>
                : <button className="outline proposal-action" disabled={busy} onClick={() => void demoPreview().catch(cause => setError(String(cause)))}>Record demo rule preview ↗</button>}
              {!!authority.result && <p className="confirmed-result"><strong>{authority.result.approved ? 'APPROVED' : 'REJECTED'}</strong> · {authority.result.reasonCode}<br/>
                {authority.result.signature && <a href={explorerTx(authority.result.signature)} target="_blank" rel="noreferrer"><code>{authority.result.signature}</code> ↗</a>}</p>}
            </div></div>}
          </div>
          <form className="composer" onSubmit={submit}>
            {attachment && <div className="attachment"><img src={attachment} alt="Attached reference"/><span>Reference image</span><button type="button" disabled={busy} onClick={() => setAttachment('')} aria-label="Remove image">×</button></div>}
            <label className="sr-only" htmlFor="request">Your request to Na</label><textarea id="request" maxLength={2000} value={text} onChange={event => setText(event.target.value)} placeholder="Tell Na what you're looking for…" rows={2} disabled={busy}/>
            <div className="composer-tools"><div><button type="button" className="attach-button" onClick={() => fileInput.current?.click()} disabled={busy}>＋ <span>Add image</span></button>
              <label className="scenario-label">Demo scenario<select value={scenario} onChange={event => setScenario(event.target.value as SearchRequest['scenario'])} disabled={busy}>
                <option value="within">Within budget</option><option value="outside">Over budget</option><option value="unverified">Missing seller claim</option><option value="wrong-market">Other marketplace</option><option value="rwa">RWA read-only</option>
              </select></label></div><button className="send-button" type="submit" disabled={busy || (!text.trim() && !attachment)} aria-label="Send request">↑</button></div>
            <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={event => {
              const file = event.target.files?.[0]; event.target.value = ''
              if (!file) return
              if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > MAX_IMAGE_BYTES) { setError('Choose a PNG, JPG or WebP up to 2 MiB.'); return }
              setError(''); const reader = new FileReader()
              reader.onload = () => { if (mounted.current && typeof reader.result === 'string') setAttachment(reader.result) }
              reader.onerror = () => setError('Could not read this image.'); reader.readAsDataURL(file)
            }}/>
          </form><div className="composer-caption">Text and images go only to the proposal API · no persistence · never on-chain</div>
        </>}
        {tab === 'mandate' && <MandateForm mandate={authority.mandate} onChain={!!authority.client} exists={authority.hasMandate} busy={busy} onSave={authority.save}/>}
        {tab === 'activity' && <ActivityHistory records={authority.records} demos={demos} busy={busy} onRefresh={authority.refresh}/>}
      </section><AuthorityPanel mandate={authority.mandate} proposal={proposal} result={authority.result} onChain={!!authority.client && authority.hasMandate} onEdit={() => navigate('/na/mandate')}/></div>
      <footer className="workspace-footer"><span>GoBuy / Built around your authority.</span><span>Demo assets · Devnet authority · No purchases</span></footer>
    </main>
  </div>
}
