import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { useAccount } from '../account/AccountContext'
import { LAMPORTS_PER_SOL } from '@solana/web3.js'
import { assetResolutionViewSchema, autonomousReconciliationSchema, type AutonomousPurchaseResult, type AutonomousReconciliation, discoveryReplySchema, nftDemoReceiptSchema, rwaReplySchema, naChatKind, naChatReplySchema,
  namedNFTQuery, namedNFTPurchaseName, type DiscoveryReply, type NFTCandidate, type NftDemoQuote, type NftDemoReceipt, type RWAReply } from '@gobuy/shared'
import { findPhantomProvider, phantomProvider, signPhantomMessage } from '../../services/solana/phantom'
import { explorerAccount, explorerTx } from '../../services/solana/links'
import { devnetConnection, requireDevnet } from '../../services/solana/network'
import { PhantomWalletProvider, type WalletProvider } from '../../services/solana/walletProvider'
import { acquisitionApi as api, AcquisitionApiError } from '../../services/api/acquisition'
import { investmentApi } from '../../services/api/investment'
import { nftDemoApi as legacyApi } from '../../services/api/nftDemo'
import { NaVaultPanel } from './components/NaVaultPanel'
import { RwaOrderDetails } from './components/RwaOrderDetails'
import { RequestHistory } from './components/RequestHistory'
import { WalletPortfolioPanel } from './components/WalletPortfolioPanel'
import { hasSolBudget, isBudgetOnlyReply, isPurchaseIntent, isCollectionPriceDiscovery } from './intentFollowUp'
import { executeAutonomousPurchase } from './autonomousPurchase'
import './chat.css'

type Message = { id: string; role: 'user' | 'na'; text: string; discovery?: DiscoveryReply; rwa?: RWAReply; quote?: NftDemoQuote; receipt?: NftDemoReceipt; autonomous?: AutonomousPurchaseResult }

export function NaWorkspacePage() {
  const account = useAccount()
  const pendingKey = 'na-devnet-pending-order:' + account.user!.uid
  const conversationKey = 'na-conversation:' + account.user!.uid
  const [conversationId] = useState(() => {
    const saved = localStorage.getItem(conversationKey)
    if (saved && /^[0-9a-f-]{36}$/i.test(saved)) return saved
    const id = crypto.randomUUID()
    localStorage.setItem(conversationKey, id)
    return id
  })
  const [messages, setMessages] = useState<Message[]>([])
  const [text, setText] = useState('')
  const [wallet, setWallet] = useState('')
  const [walletLinked, setWalletLinked] = useState(false)
  const [balance, setBalance] = useState<number | null>(null)
  const [networkError, setNetworkError] = useState('')
  const [devnetReady, setDevnetReady] = useState(false)
  const [walletNotice, setWalletNotice] = useState('')
  const [vaultRevision, setVaultRevision] = useState(0)
  const [requestHistoryRevision, setRequestHistoryRevision] = useState(0)
  const walletRef = useRef('')
  const pendingPurchaseIntent = useRef('')
  const pendingRwaPrompt = useRef('')
  const walletProvider = useRef<WalletProvider>(new PhantomWalletProvider())
  const [discoveryMode, setDiscoveryMode] = useState('Đang kiểm tra nguồn dữ liệu')
  async function refreshBalance(owner = walletRef.current) {
    if (!owner) return
    try {
      if (walletProvider.current.getAddress() !== owner) throw new Error('Kết nối lại đúng ví để đọc số dư.')
      const value = await walletProvider.current.getBalance()
      if (walletRef.current === owner) { setBalance(value / LAMPORTS_PER_SOL); setNetworkError('') }
    } catch (error) {
      if (walletRef.current === owner) { setBalance(null); setNetworkError(error instanceof Error ? error.message : 'Devnet RPC unavailable.') }
    }
  }
  const [busy, setBusy] = useState(false)
  const [stage, setStage] = useState('')
  const [pendingOrder, setPendingOrder] = useState(() => localStorage.getItem(pendingKey) || '')
  const lock = useRef(false)
  const feed = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLTextAreaElement>(null)
  const add = (message: Omit<Message, 'id'>) => setMessages(current => [...current, { id: crypto.randomUUID(), ...message }])
  // Reconciliation is account-scoped and read-only; naming the connected owner lets the backend bind it.
  const reconcileUrl = (id: string) => '/autonomous-spends/' + id + (walletRef.current ? '?owner=' + encodeURIComponent(walletRef.current) : '')
  /**
   * NFT vs RWA is decided by the backend AssetResolver, never by a keyword list here: a hardcoded
   * list sent any unlisted asset (NVDAx) into the NFT discovery flow.
   */
  async function classifyAsset(value: string) {
    return assetResolutionViewSchema.parse(await investmentApi('/asset/resolve', { text: value }))
  }
  /**
   * Re-checks one conditional order: the price is re-quoted on mainnet and the policy is revalidated
   * before anything could execute. It never creates a second order.
   */
  async function evaluateRwaOrder(messageId: string, orderId: string) {
    if (lock.current) return
    lock.current = true; setBusy(true); setStage('Na đang kiểm tra lại giá mainnet và policy…')
    try {
      const reply = rwaReplySchema.parse(await investmentApi('/rwa/orders/' + orderId + '/evaluate', wallet ? { owner: wallet } : {}))
      setMessages(current => current.map(message => message.id === messageId ? { ...message, text: reply.message, rwa: reply } : message))
      setRequestHistoryRevision(value => value + 1)
    } catch (error) {
      add({ role: 'na', text: error instanceof Error ? error.message : 'Chưa kiểm tra lại được điều kiện RWA. Không có giao dịch nào được tạo.' })
    } finally { lock.current = false; setBusy(false); setStage('') }
  }
  useEffect(() => { feed.current?.scrollTo({ top: feed.current.scrollHeight, behavior: 'smooth' }) }, [messages, stage])
  useEffect(() => {
    void requireDevnet(devnetConnection()).catch(error => setNetworkError(error instanceof Error ? error.message : 'Devnet RPC unavailable.'))
    void api('/config').then(config => {
      const value = config as { discoveryMode: string; discoveryNetwork: string; tensorMarketplace?: boolean }
      setDiscoveryMode(value.discoveryMode === 'mock' ? 'Mock Gallery · Dữ liệu mẫu' : value.tensorMarketplace
        ? `Marketplace · ${value.discoveryNetwork} · Tensor Devnet`
        : `Marketplace · ${value.discoveryNetwork} chỉ đọc`)
    }).catch(() => setDiscoveryMode('Chưa xác minh được nguồn dữ liệu'))
  }, [])
  useEffect(() => {
    const provider = findPhantomProvider()
    const reset = () => { walletRef.current = ''; setWallet(''); setWalletLinked(false); setBalance(null); setDevnetReady(false); setWalletNotice('') }
    provider?.on('accountChanged', reset); provider?.on('disconnect', reset)
    return () => { provider?.removeListener('accountChanged', reset); provider?.removeListener('disconnect', reset) }
  }, [wallet])
  async function connect() {
    setWalletLinked(false)
    const provider = walletProvider.current
    const owner = await provider.connect()
    if (provider.getAddress() !== owner) throw new Error('Ví đã thay đổi trong lúc kết nối.')
    if (walletRef.current !== owner) setBalance(null)
    walletRef.current = owner
    setWallet(owner)
    await refreshBalance(owner)
    const linked = await api('/wallets') as Array<{ address: string; verified: boolean }>
    setWalletLinked(linked.some(item => item.address === owner && item.verified))
    setRequestHistoryRevision(value => value + 1)
    return { provider, owner }
  }
  // Explicit account authentication, separate from PURCHASE. Never called as an execution fallback.
  async function verifyWalletLink() {
    if (lock.current || !wallet) return
    lock.current = true; setBusy(true)
    try {
      const owner = walletRef.current, provider = await phantomProvider()
      if (provider.publicKey?.toBase58() !== owner) throw new Error('Connected wallet changed.')
      const challenge = await api('/wallets/challenge', { address: owner }) as { id: string; message: string }
      const signature = await signPhantomMessage(provider, challenge.message)
      if (provider.publicKey?.toBase58() !== owner || walletRef.current !== owner) throw new Error('Connected wallet changed.')
      await api('/wallets/verify', { id: challenge.id, signature })
      setWalletLinked(true)
      add({ role: 'na', text: 'Đã xác minh liên kết ví với tài khoản GoBuy. Chưa tạo hoặc gửi giao dịch chi tiêu.' })
    } catch (error) { add({ role: 'na', text: error instanceof Error ? error.message : 'Wallet association failed.' }) }
    finally { lock.current = false; setBusy(false) }
  }
  async function walletButton() {
    if (lock.current) return
    lock.current = true; setBusy(true)
    try { await connect() }
    catch (e) { add({ role: 'na', text: e instanceof Error ? e.message : 'Chưa kết nối được Phantom.' }) }
    finally { lock.current = false; setBusy(false); setStage('') }
  }
  function complete(receipt: NftDemoReceipt) {
    if (receipt.status === 'CONFIRMED' || receipt.status === 'FAILED') {
      localStorage.removeItem(pendingKey); setPendingOrder('')
      void refreshBalance()
    }
  }
  async function checkOrder() {
    if (lock.current || !pendingOrder) return
    lock.current = true; setBusy(true); setStage('Đang kiểm tra giao dịch trên devnet…')
    try {
      if (localStorage.getItem(pendingKey + ':engine') === 'autonomous') {
        const reply = autonomousReconciliationSchema.parse(await api(reconcileUrl(pendingOrder)))
        showReconciliation(reply)
        setRequestHistoryRevision(value => value + 1)
        return
      }
      const requestApi = localStorage.getItem(pendingKey + ':engine') === 'acquisition' ? api : legacyApi
      const receipt = nftDemoReceiptSchema.parse(await requestApi('/orders/' + pendingOrder))
      setRequestHistoryRevision(value => value + 1)
      add({ role: 'na', text: receipt.message, receipt }); complete(receipt)
    } catch { add({ role: 'na', text: 'Chưa kiểm tra được giao dịch. Na giữ mã yêu cầu và không mua lại. Bạn có thể kiểm tra lại sau.' }) }
    finally { lock.current = false; setBusy(false); setStage('') }
  }
  async function submit(event: FormEvent) {
    event.preventDefault()
    const request = text.trim()
    if (!request || lock.current || pendingOrder) return
    lock.current = true; setBusy(true); setWalletNotice('')
    let autoAcquire: { discovery: DiscoveryReply; candidate: NFTCandidate } | undefined
    try {
      const budgetOnlyReply = isBudgetOnlyReply(request)
      const previousIntent = pendingPurchaseIntent.current
      const hasContext = messages.some(message => message.discovery)
      const lastQuestion = messages.filter(message => message.role === 'user').at(-1)?.text
      const rankingAnswer = lastQuestion && naChatKind(lastQuestion, hasContext) === 'ranking'
        && /\b(hiem|rarity|rarest|re nhat|gia thap|cheapest|lowest price|mua nhieu|most bought|momentum|thanh khoan|liquidity|trending|xu huong)\b/.test(
          request.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd'))
        && !hasSolBudget(request)
      const combinedRequest = rankingAnswer ? `Chỉ tìm, ${lastQuestion} ${request}`
        : budgetOnlyReply && previousIntent ? `${previousIntent} ${request}` : request
      const chatKind = naChatKind(combinedRequest, hasContext)
      if (chatKind) {
        setText(''); add({ role: 'user', text: request }); setStage('Na đang trả lời…')
        const reply = naChatReplySchema.parse(await api('/chat', { text: combinedRequest, conversationId }))
        add({ role: 'na', text: reply.message })
        return
      }
      const pendingRwa = pendingRwaPrompt.current
      const rwaAmountReply = /^\s*(?:about\s*)?\d+(?:[.,]\d{1,9})?\s*(?:usdc|usd|sol)\s*$/i.test(request)
      // A follow-up amount stays in the RWA flow; anything else is classified by the backend.
      const isRwa = !!pendingRwa && rwaAmountReply ? true : (await classifyAsset(request)).assetType === 'RWA'
      if (isRwa) {
        const rwaText = pendingRwa && rwaAmountReply ? `${pendingRwa} ${request}` : request
        setText(''); add({ role: 'user', text: request })
        setStage('Na đang kiểm tra registry RWA và quote mainnet…')
        const rwa = rwaReplySchema.parse(await investmentApi('/rwa/discover', { text: rwaText, ...(wallet ? { owner: wallet } : {}) }))
        pendingRwaPrompt.current = rwa.status === 'NEEDS_INPUT' ? rwaText : ''
        add({ role: 'na', text: rwa.message, rwa })
        return
      }
      if (budgetOnlyReply && !previousIntent && !hasContext) {
        setText(''); add({ role: 'user', text: request })
        add({ role: 'na', text: 'Bạn muốn tìm hoặc mua NFT nào? Nói tên tranh, bộ sưu tập hoặc chủ đề bạn thích nhé.' })
        return
      }
      if (!hasContext && !hasSolBudget(combinedRequest) && isPurchaseIntent(combinedRequest) && !isCollectionPriceDiscovery(combinedRequest) && !namedNFTQuery(combinedRequest) && !namedNFTPurchaseName(combinedRequest)) {
        pendingPurchaseIntent.current = combinedRequest
        setText(''); add({ role: 'user', text: request })
        const response = 'Được, mình sẽ tìm theo yêu cầu đó. Bạn muốn giới hạn giá tối đa bao nhiêu SOL? Trả lời tự nhiên, ví dụ “dưới 1 SOL” hoặc “tầm 0.5 SOL”.'
        await api('/requests', { id: crypto.randomUUID(), prompt: request, response })
        setRequestHistoryRevision(value => value + 1)
        add({ role: 'na', text: response })
        return
      }
      pendingPurchaseIntent.current = ''
      setStage('Na đang hiểu chủ đề, lấy listing và kiểm tra ngân sách…')
      setText(''); add({ role: 'user', text: request })
      const discovery = discoveryReplySchema.parse(await api('/discover', { id: crypto.randomUUID(), text: combinedRequest, prompt: request, conversationId, ...(wallet ? { owner: wallet } : {}) }))
      add({ role: 'na', text: discovery.message, discovery })
      if (discovery.intent.priceDiscoveryOnly && discovery.candidates[0] && discovery.candidates[0].sourceNetwork !== 'mainnet') {
        pendingPurchaseIntent.current = combinedRequest
        const price = Number(discovery.candidates[0].listing.priceLamports)
        add({ role: 'na', text: `Giá listing thấp nhất tìm được là ${price / 1e9} SOL, chưa gồm phí. Chưa có tổng chi đã xác minh; Na không tự cộng một khoản phí giả hoặc tăng hạn mức. Bạn có thể nêu mức tối đa bằng SOL để kiểm tra tiếp.` })
      }
      if (!discovery.intent.priceDiscoveryOnly && discovery.intent.action === 'BUY' && discovery.candidates[0] && discovery.candidates[0].sourceNetwork !== 'mainnet') {
        autoAcquire = { discovery, candidate: discovery.candidates[0] }
      }
    } catch (e) {
      setText(request)
      add({ role: 'na', text: e instanceof Error ? e.message : 'Không tìm được dữ liệu NFT. Thử lại sau.' })
    } finally {
      setRequestHistoryRevision(value => value + 1)
      lock.current = false; setBusy(false); setStage(''); input.current?.focus()
    }
    if (autoAcquire) void acquire(autoAcquire.discovery, autoAcquire.candidate)
  }
  function showReconciliation(reply: AutonomousReconciliation) {
    // Reconciliation is read-only: it reports chain/database state and never resubmits a spend.
    if (reply.purchase) add({ role: 'na', text: reply.message, autonomous: reply.purchase })
    else add({ role: 'na', text: reply.message })
    if (reply.status === 'PENDING' || reply.status === 'RECONCILIATION_ERROR') return
    localStorage.removeItem(pendingKey); setPendingOrder('')
    setVaultRevision(value => value + 1)
    void refreshBalance()
  }
  function showAutonomous(reply: AutonomousPurchaseResult) {
    add({ role: 'na', text: reply.result.message, autonomous: reply })
    if (reply.result.status !== 'PENDING') {
      localStorage.removeItem(pendingKey); setPendingOrder('')
      setVaultRevision(value => value + 1)
      void refreshBalance()
    }
  }
  async function acquire(discovery: DiscoveryReply, candidate: NFTCandidate) {
    if (lock.current || pendingOrder) return
    lock.current = true; setBusy(true); setWalletNotice('')
    try {
      const owner = walletRef.current
      if (discovery.intent.action !== 'BUY' || discovery.intent.priceDiscoveryOnly) throw new Error('SEARCH only recommends. Send a PURCHASE request with a budget to execute the Devnet demo.')
      if (!owner) throw new Error('Connect the wallet that owns the mandate before execution.')
      if (!walletLinked) throw new Error('Ví chưa được liên kết đã xác minh với tài khoản GoBuy. Dùng bước xác minh liên kết ví riêng trước khi yêu cầu PURCHASE. Chưa chi SOL; không mở Phantom làm fallback.')
      if (candidate.sourceNetwork !== 'devnet') throw new Error('Autonomous spend requires a verified Devnet listing.')
      await requireDevnet(devnetConnection())
      setStage('Validating listing and mandate for Devnet autonomous spend demo; Na Agent signs server-side...')
      // Save before POST: a dropped response must never cause a new spend request.
      localStorage.setItem(pendingKey + ':engine', 'autonomous')
      localStorage.setItem(pendingKey, discovery.id); setPendingOrder(discovery.id)
      let purchase = await executeAutonomousPurchase(api, discovery, candidate, owner)
      for (let attempt = 0; attempt < 8 && purchase.result.status === 'PENDING'; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 2000))
        const reconciled = autonomousReconciliationSchema.parse(await api(reconcileUrl(discovery.id)))
        if (reconciled.purchase) purchase = reconciled.purchase
        if (reconciled.status !== 'PENDING') break
      }
      showAutonomous(purchase)
    } catch (error) {
      if (error instanceof AcquisitionApiError && error.executionStarted === false) {
        localStorage.removeItem(pendingKey); setPendingOrder('')
      }
      add({ role: 'na', text: error instanceof Error ? error.message : 'Execution could not be confirmed. Check the pending request; do not create another spend.' })
    } finally {
      setRequestHistoryRevision(value => value + 1)
      lock.current = false; setBusy(false); setStage(''); input.current?.focus()
    }
  }
  return <main className="na-chat-app">
    <header className="chat-header"><a href="/na" className="chat-brand">na<span>·</span></a><div className="chat-title"><strong>Trợ lý tìm &amp; mua tài sản NFT / RWA</strong><span>{discoveryMode}</span></div>
      <Link className="chat-account" to="/account">Tài khoản &amp; địa chỉ</Link>
      <button className="chat-wallet" disabled={busy} onClick={() => void walletButton()}>{wallet ? `${wallet.slice(0, 4)}…${wallet.slice(-4)}` : 'Kết nối Phantom'}</button>
      <button className="chat-logout" disabled={busy || !!pendingOrder} onClick={() => void account.logout()} title="Đăng xuất khỏi GoBuy" aria-label="Đăng xuất khỏi GoBuy">
        <svg className="chat-logout-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path d="M15 4h2.5A2.5 2.5 0 0 1 20 6.5v11a2.5 2.5 0 0 1-2.5 2.5H15M10 16l-4-4 4-4M6 12h9" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
        <span>Đăng xuất</span>
      </button>
    </header>
    <section className="devnet-wallet" aria-label="Devnet wallet status">
      <strong className="devnet-badge">DEVNET</strong><span>Network: Solana Devnet</span>
      {wallet && <><span>Phantom · {wallet.slice(0, 4)}…{wallet.slice(-4)}</span>
        {!walletLinked && <button disabled={busy} onClick={() => void verifyWalletLink()}>Xác minh liên kết ví với GoBuy (ký thông điệp, không gửi giao dịch)</button>}
        <span>{balance === null ? 'Balance unavailable' : balance.toFixed(4) + ' Devnet SOL'}</span>
        <label><input type="checkbox" checked={devnetReady} disabled={busy} onChange={e => { setDevnetReady(e.target.checked); setWalletNotice('') }}/> Tôi đã bật Devnet trong Phantom</label></>}
      {!devnetReady && <p>Bật Testnet Mode và chọn Solana Devnet trong Phantom trước khi mua.</p>}
      {walletNotice && <p role="status">{walletNotice}</p>}
      {networkError && <p role="alert">{networkError}</p>}
    </section>
    <div className="chat-network-note">PURCHASE dùng Na Agent để thực hiện Devnet autonomous spend demo từ Na Vault. Đây chưa phải mua NFT hoàn chỉnh; không xác nhận NFT chuyển vào ví. SEARCH chỉ đề xuất, không chi SOL.</div>
    <section className="chat-utility-panels" aria-label="Ví, tài sản và yêu cầu">
      <NaVaultPanel revision={vaultRevision} wallet={wallet} devnetReady={devnetReady} onChanged={() => void refreshBalance()}/>
      <WalletPortfolioPanel revision={requestHistoryRevision}/>
      <RequestHistory revision={requestHistoryRevision}/>
    </section>
    <div className="chat-feed" ref={feed} role="log" aria-label="Cuộc trò chuyện với Na" aria-live="polite">
      {!messages.length && <section className="chat-welcome"><span className="chat-orbit">✳</span><h1>Bạn muốn tìm NFT nào?</h1><p>Nói chủ đề và ngân sách SOL.<br/>Na chọn listing phù hợp. Khi bạn yêu cầu PURCHASE, Na kiểm tra mandate để thực hiện Devnet autonomous spend demo; không yêu cầu Phantom ký lần hai và chưa mua NFT.</p>
        <div className="chat-prompts">{['Find me an ocean-themed NFT under 1 SOL.', 'Tìm tranh NFT về mèo dưới 0.5 SOL'].map(prompt => <button key={prompt} onClick={() => { setText(prompt); input.current?.focus() }}>{prompt}<span>↗</span></button>)}</div>
      </section>}
      {messages.map(message => <article key={message.id} className={`chat-message ${message.role}`}>
        {message.role === 'na' && <span className="chat-avatar">na·</span>}
        <div className="chat-bubble"><p>{message.text}</p>
          {message.rwa && <RwaOrderDetails reply={message.rwa} busy={busy} onEvaluate={id => void evaluateRwaOrder(message.id, id)}/>}
          {message.rwa && <section className="chat-rwa-result" aria-label="Thông tin RWA">
            {message.rwa.asset && <><strong>{message.rwa.asset.name} ({message.rwa.asset.symbol})</strong>
              <p>{message.rwa.asset.category} · Issuer: {message.rwa.asset.issuer}</p>
              <p>Underlying: {message.rwa.asset.underlying}</p>
              <p>Registry: <a href={message.rwa.asset.verificationSource} target="_blank" rel="noreferrer">nguồn xác minh</a></p></>}
            {message.rwa.quote && <><p>Quote mainnet: {message.rwa.quote.inAmount} input units → {message.rwa.quote.minOutput} output units tối thiểu.</p>
              <p>Route: {message.rwa.quote.route.join(' → ')} · Slippage: {message.rwa.quote.slippageBps} bps</p>
              <p>Đây chỉ là báo giá Solana mainnet. Chưa chuẩn bị hoặc gửi giao dịch; swap thật đang bị tắt.</p></>}
            {message.rwa.warnings.map((warning, index) => <p className="candidate-warning" key={index}>{warning}</p>)}
          </section>}
          {message.discovery && <div>
            {message.discovery.research?.verified && <section aria-label="Bằng chứng nghiên cứu Mainnet">
              <strong>MAINNET · Chỉ nghiên cứu, không mua được</strong>
              <p>Network: Solana Mainnet · Collection: {message.discovery.research.collection}</p>
              <p>Collection ID: <a href={`https://explorer.solana.com/address/${message.discovery.research.collectionId}?cluster=mainnet-beta`} target="_blank" rel="noreferrer">{message.discovery.research.collectionId}</a></p>
              <p>Nguồn dữ liệu: {message.discovery.research.source} · NFT đã kiểm tra: {message.discovery.research.assetsChecked}</p>
              <p>Nguồn xác định collection: {message.discovery.research.resolverSource}</p>
              <p>Nguồn giá: chưa có · Thực thi: MAINNET_READ_ONLY · Chưa tạo giao dịch</p>
              <p>Kiểm tra lúc {new Date(message.discovery.research.checkedAt).toLocaleString('vi-VN')}</p>
              {message.discovery.research.assets.map(asset => <div className="chat-art nft-candidate" key={asset.mint}>
                {asset.image && <img src={asset.image} alt={asset.name} referrerPolicy="no-referrer" onError={event => { event.currentTarget.style.display = 'none' }}/>}
                <div><small>MAINNET · Không mua được</small><h3>{asset.name}</h3>
                  <p>{asset.reasons.join(' ')}</p><p>Giá niêm yết: chưa có dữ liệu</p>
                  <a href={`https://explorer.solana.com/address/${asset.mint}?cluster=mainnet-beta`} target="_blank" rel="noreferrer">Kiểm tra NFT trên Mainnet ↗</a>
                </div>
              </div>)}
            </section>}
            {message.discovery.warnings.map((warning, index) => <p className="candidate-warning" key={index}>{warning}</p>)}
            {message.discovery.candidates.map(candidate => <div className="chat-art nft-candidate" key={candidate.id}>
              {candidate.image ? <img src={candidate.image} alt={candidate.name} referrerPolicy="no-referrer" onError={event => { event.currentTarget.style.display = 'none' }}/>
                : <span className="candidate-no-image">Chưa có ảnh</span>}
              <div><small>{candidate.sourceNetwork === 'mainnet' ? 'MAINNET · Chỉ xem, không mua được' : `${candidate.provider} · ${candidate.sourceNetwork}`}</small><h3>{candidate.name}</h3>
                <strong>{Number(candidate.listing.priceLamports) / 1e9} SOL · Giá niêm yết</strong>
                {message.discovery!.ranking && <p>Acquisition Score {message.discovery!.ranking!.score}/100 · Độ tin cậy {message.discovery!.ranking!.confidence}/100</p>}
                {message.discovery!.ranking?.reasons.map(reason => <p key={reason}>{reason}</p>)}
                <p>{candidate.reasons.join(' ')}</p><p>{candidate.warnings.join(' ')}</p>
                <p>Đọc lúc {new Date(candidate.listing.observedAt).toLocaleString('vi-VN')}</p>
                {candidate.listing.url && <a href={candidate.listing.url} target="_blank" rel="noreferrer">Đối chiếu marketplace ↗</a>}
                {candidate.mint && <a href={candidate.sourceNetwork === 'mainnet' ? `https://explorer.solana.com/address/${candidate.mint}?cluster=mainnet-beta` : explorerAccount(candidate.mint)} target="_blank" rel="noreferrer">Kiểm tra mint trên Explorer ↗</a>}
                <button disabled={busy || !!pendingOrder || candidate.sourceNetwork !== 'devnet' || message.discovery!.intent.action !== 'BUY' || !!message.discovery!.intent.priceDiscoveryOnly} onClick={() => void acquire(message.discovery!, candidate)}>
                  {candidate.sourceNetwork === 'mainnet' ? 'MAINNET · Không mua được' : message.discovery!.intent.action === 'SEARCH' ? 'SEARCH: chỉ đề xuất' : 'Devnet autonomous spend demo'}
                </button>
              </div>
            </div>)}
          </div>}
          {message.autonomous && <AutonomousSpendDetails reply={message.autonomous}/>}
          {message.quote && <div className="chat-art"><img src={message.quote.image} alt={message.quote.title}/><div><small>DEVNET SIMULATION</small><h3>{message.quote.title}</h3><strong>{message.quote.priceLamports / 1e9} SOL thử nghiệm</strong><p>Phí đã được tính trong tổng dự kiến ở trên. Không mua NFT gốc.</p></div></div>}
          {message.receipt?.signature && <code className="transaction-signature">{message.receipt.signature}</code>}
          {message.receipt?.signature && <a className="chat-receipt" href={explorerTx(message.receipt.signature)} target="_blank" rel="noreferrer">Xem giao dịch devnet ↗</a>}
          {message.receipt?.status === 'CONFIRMED' && message.receipt.asset && <a className="chat-receipt" href={explorerAccount(message.receipt.asset)} target="_blank" rel="noreferrer">Xem NFT trong ví ↗</a>}
        </div>
      </article>)}
      {stage && <p className="chat-progress" role="status"><span/>{stage}</p>}
    </div>
    <div className="chat-bottom">
      {pendingOrder && <div className="chat-pending">Một giao dịch đang chờ kiểm tra. Na tạm dừng mua mới.<button disabled={busy} onClick={() => void checkOrder()}>Kiểm tra giao dịch</button></div>}
      <form className="chat-composer" onSubmit={submit}>
        <label className="sr-only" htmlFor="na-input">Tin nhắn cho Na</label>
        <textarea id="na-input" ref={input} value={text} maxLength={2000} rows={2} placeholder="Ví dụ: Tìm tranh NFT về biển dưới 1 SOL"
          onChange={e => setText(e.target.value)} onKeyDown={e => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229) { e.preventDefault(); e.currentTarget.form?.requestSubmit() }
          }}/>
        <button className="chat-send" aria-label="Gửi tin nhắn" disabled={busy || !!pendingOrder || !text.trim()} type="submit">↑</button>
      </form><p className="chat-hint">Enter để gửi · Shift + Enter để xuống dòng · Không dùng SOL thật</p>
    </div>
  </main>
}

function AutonomousSpendDetails({ reply }: { reply: AutonomousPurchaseResult }) {
  const { result } = reply
  const sol = (value: string | undefined | null) => value == null ? 'Unavailable' : (Number(value) / 1e9).toFixed(9) + ' SOL'
  return <section aria-label="Devnet autonomous spend demo">
    <strong>{reply.execution}</strong><p>Selected: {reply.selected.name}</p>
    <p>Listing: {reply.selected.marketplaceListing.listingId}</p>
    <p>Listing price: {sol(reply.listingPriceLamports)} · Actual demo spend: {sol(reply.actualSpendLamports)}</p>
    <p>Mandate PDA: {result.mandate?.address ?? result.spend?.mandate ?? 'Unavailable'} · {result.mandate?.status}</p>
    <p>Vault PDA: {result.mandate?.vault ?? 'Unavailable'}</p>
    <p>Spent before: {sol(result.spend?.spentBeforeLamports)} · Spent after: {sol(result.spend?.spentAfterLamports)}</p>
    <p>Remaining budget: {sol(result.mandate?.remainingLamports)}</p>
    <p>Signed by: {reply.signedBy} · Phantom signature required: No</p>
    <p>Status: {result.status}{result.rejection ? ' · ' + result.rejection : ''}</p>
    {result.signature && <><code>{result.signature}</code><a href={explorerTx(result.signature)} target="_blank" rel="noreferrer">Solana Explorer Devnet</a></>}
  </section>
}
