import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { useAccount } from '../account/AccountContext'
import { LAMPORTS_PER_SOL } from '@solana/web3.js'
import { assetResolutionViewSchema, autonomousReconciliationSchema, type AutonomousPurchaseResult, type AutonomousReconciliation, discoveryReplySchema, nftDemoReceiptSchema, rwaReplySchema, naChatKind, naChatReplySchema,
  namedNFTQuery, namedNFTPurchaseName, type DiscoveryReply, type NftDemoQuote, type NftDemoReceipt, type RWAReply } from '@gobuy/shared'
import { findPhantomProvider, phantomProvider, signPhantomMessage } from '../../services/solana/phantom'
import { explorerAccount, explorerTx } from '../../services/solana/links'
import { devnetConnection, requireDevnet } from '../../services/solana/network'
import { PhantomWalletProvider, type WalletProvider } from '../../services/solana/walletProvider'
import { acquisitionApi as api } from '../../services/api/acquisition'
import { investmentApi } from '../../services/api/investment'
import { nftDemoApi as legacyApi } from '../../services/api/nftDemo'
import { NaConsole } from './components/NaConsole'
import { NaVaultPanel } from './components/NaVaultPanel'
import { RwaOrderDetails } from './components/RwaOrderDetails'
import { RequestHistory, purchasePhaseLabel, statusLabel } from './components/RequestHistory'
import { WalletPortfolioPanel } from './components/WalletPortfolioPanel'
import { hasSolBudget, isBudgetOnlyReply, isPurchaseIntent, isCollectionPriceDiscovery } from './intentFollowUp'
import { nftPurchaseApi } from '../../services/api/nftPurchase'
import { GenuineNftPurchase, GenuinePurchaseResult } from './components/GenuineNftPurchase'
import { genuineDeliveryVerified } from './genuinePurchase'
import type { NftPurchaseResult } from '@gobuy/shared'
import './chat.css'
import { deliveryStatusLabel, deliveryPollingFinished } from './deliveryStatus'
import { naRequestSchema, type NaRequest } from '@gobuy/shared'

/** `order` carries the saved request/order snapshot so a reopened conversation shows its status. */
type Message = { id: string; role: 'user' | 'na'; text: string; restoredOwner?: string; order?: NaRequest; discovery?: DiscoveryReply; rwa?: RWAReply; quote?: NftDemoQuote; receipt?: NftDemoReceipt; autonomous?: AutonomousPurchaseResult; genuine?: NftPurchaseResult }

export function NaWorkspacePage() {
  const account = useAccount()
  const pendingKey = 'na-devnet-pending-order:' + account.user!.uid
  const conversationKey = 'na-conversation:' + account.user!.uid
  const [conversationId, setConversationId] = useState(() => {
    const saved = localStorage.getItem(conversationKey)
    if (saved && /^[0-9a-f-]{36}$/i.test(saved)) return saved
    const id = crypto.randomUUID()
    localStorage.setItem(conversationKey, id)
    return id
  })
  const [messages, setMessages] = useState<Message[]>([])
  const [historyConversation, setHistoryConversation] = useState(false)
  const [text, setText] = useState('')
  const [wallet, setWallet] = useState('')
  const [walletLinked, setWalletLinked] = useState(false)
  const visibleMessages = messages.filter(message => !message.restoredOwner || message.restoredOwner === wallet)
  const [balance, setBalance] = useState<number | null>(null)
  const [networkError, setNetworkError] = useState('')
  const [devnetReady, setDevnetReady] = useState(false)
  const [walletNotice, setWalletNotice] = useState('')
  const [vaultRevision, setVaultRevision] = useState(0)
  const [requestHistoryRevision, setRequestHistoryRevision] = useState(0)
  const [deliveryRecoveryRevision, setDeliveryRecoveryRevision] = useState(0)
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
  /**
   * Reopens one saved conversation.
   *
   * The click used to return silently whenever no wallet was connected, so the button looked dead.
   * It now always answers. Rows are replaced atomically for a single conversation id, and the saved
   * order snapshot is carried onto the restored messages so the recorded status is visible again.
   * A restored order is read-only history: it never re-authorizes a purchase.
   */
  async function openHistory(request: NaRequest) {
    if (lock.current) return
    if (!wallet) { setWalletNotice('Kết nối ví đã dùng cho cuộc trò chuyện này để mở lại lịch sử.'); return }
    lock.current = true; setBusy(true)
    const owner = wallet
    try {
      const result = await api('/requests/' + request.id + '/resume', {}) as { conversationId: string; requests: unknown; discovery?: unknown }
      if (walletRef.current !== owner) return
      const rows = naRequestSchema.array().parse(result.requests)
      const discovery = result.discovery ? discoveryReplySchema.parse(result.discovery) : undefined
      // Historical listings are context, never fresh purchase authorization.
      if (discovery) discovery.intent = { ...discovery.intent, action: 'SEARCH' }
      setConversationId(result.conversationId); localStorage.setItem(conversationKey, result.conversationId)
      // One conversation at a time: every restored message is scoped to the wallet that owns it.
      setMessages(rows.flatMap(row => [
        { id: row.id + ':user', role: 'user' as const, text: row.prompt, restoredOwner: owner },
        ...(row.response ? [{ id: row.id + ':na', role: 'na' as const, text: row.response, restoredOwner: owner,
          ...(hasSavedOrder(row) ? { order: row } : {}),
          ...(row.id === request.id && discovery ? { discovery } : {}) }] : []),
      ]))
      setHistoryConversation(true); setText('')
      pendingPurchaseIntent.current = request.status === 'NEEDS_INPUT' && !discovery ? request.prompt : ''
      pendingRwaPrompt.current = ''
      setWalletNotice('Đã mở lại cuộc trò chuyện đã lưu. Đây là lịch sử; Na không gửi giao dịch mới.')
      input.current?.focus()
    } catch (error) { setWalletNotice(error instanceof Error ? error.message : 'Chưa mở được cuộc trò chuyện. Thử lại trong Lịch sử.') }
    finally { lock.current = false; setBusy(false) }
  }
  // Account-scoped reconciliation may retry delivery, but never repeats a confirmed payment.
  const reconcileUrl = (id: string) => '/autonomous-spends/' + id + (walletRef.current ? '?owner=' + encodeURIComponent(walletRef.current) : '')
  useEffect(() => {
    if (historyConversation || !wallet || !walletLinked || !pendingOrder || localStorage.getItem(pendingKey + ':engine') !== 'autonomous') return
    let active = true, running = false, done = false
    const poll = async () => {
      if (!active || running || done || document.hidden) return
      running = true
      try {
        // Database-only status read. The backend worker owns transaction submission.
        const reply = autonomousReconciliationSchema.parse(await api('/autonomous-spends/' + pendingOrder + '?readOnly=true'))
        if (!active || walletRef.current !== wallet || !reply.purchase) return
        const purchase = reply.purchase
        const owner = purchase.delivery?.owner ?? purchase.result.mandate?.owner
        if (owner !== wallet) return
        setMessages(current => {
          let index = -1
          current.forEach((message, i) => { if (message.autonomous?.id === pendingOrder) index = i })
          const message: Message = { id: index >= 0 ? current[index].id : crypto.randomUUID(), role: 'na', text: reply.message,
            restoredOwner: index >= 0 ? current[index].restoredOwner : wallet, autonomous: purchase }
          return index < 0 ? [...current, message] : current.map((row, i) => i === index ? message : row)
        })
        done = deliveryPollingFinished(purchase.delivery)
        if (done) setRequestHistoryRevision(value => value + 1)
        if (purchase.phase === 'COMPLETED') {
          localStorage.removeItem(pendingKey); setPendingOrder(''); setVaultRevision(value => value + 1)
        }
      } catch { /* A status read failure never clears the paid order. */ }
      finally { running = false }
    }
    const timer = window.setInterval(() => { void poll() }, 8000)
    document.addEventListener('visibilitychange', poll)
    void poll()
    return () => { active = false; window.clearInterval(timer); document.removeEventListener('visibilitychange', poll) }
  }, [pendingOrder, pendingKey, wallet, walletLinked, historyConversation, deliveryRecoveryRevision])
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
    void api('/config').then(config => {
      const value = config as { discoveryMode: string; discoveryNetwork: string; tensorMarketplace?: boolean }
      setDiscoveryMode(value.discoveryMode === 'mock' ? 'Mock Gallery · Dữ liệu mẫu' : value.tensorMarketplace
        ? `Marketplace · ${value.discoveryNetwork} · Tensor Devnet`
        : `Marketplace · ${value.discoveryNetwork} chỉ đọc`)
    }).catch(() => setDiscoveryMode('Chưa xác minh được nguồn dữ liệu'))
  }, [])
  useEffect(() => {
    if (!wallet) { setNetworkError(''); return }
    let active = true
    void requireDevnet(devnetConnection()).catch(error => {
      if (active) setNetworkError(error instanceof Error ? error.message : 'Devnet RPC unavailable.')
    })
    return () => { active = false }
  }, [wallet])
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
    void refreshBalance(owner)
    setStage('Đã kết nối Phantom. Đang kiểm tra liên kết với GoBuy…')
    const linked = await api('/wallets') as Array<{ address: string; verified: boolean }>
    if (walletRef.current !== owner || provider.getAddress() !== owner) throw new Error('Ví đã thay đổi trong lúc kiểm tra liên kết.')
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
    setStage('Đang chờ Phantom. Mở extension, mở khóa ví và xác nhận kết nối…')
    try { await connect() }
    catch (e) { add({ role: 'na', text: e instanceof Error ? e.message : 'Chưa kết nối được Phantom.' }) }
    finally { lock.current = false; setBusy(false); setStage('') }
  }
  async function acceptDemoReplacement(reply: AutonomousPurchaseResult) {
    if (lock.current || !wallet || !walletLinked) return
    if (!window.confirm('Bạn đồng ý nhận một NFT DEMO mô phỏng thay thế? Đây không phải NFT marketplace gốc. Khoản thanh toán cũ được giữ nguyên, không trừ thêm SOL từ Vault.')) return
    lock.current = true; setBusy(true)
    try {
      const owner = walletRef.current
      const challenge = await api(`/autonomous-spends/${reply.id}/demo-consent`, { owner }) as { id: string; message: string }
      const provider = await phantomProvider()
      if (provider.publicKey?.toBase58() !== owner) throw new Error('Kết nối đúng ví đã mua.')
      const signature = await signPhantomMessage(provider, challenge.message)
      if (walletRef.current !== owner || provider.publicKey?.toBase58() !== owner) throw new Error('Ví đã thay đổi.')
      await api(`/autonomous-spends/${reply.id}/demo-recovery`, { challengeId: challenge.id, signature })
      const updated = autonomousReconciliationSchema.parse(await api(`/autonomous-spends/${reply.id}?readOnly=true`))
      if (updated.purchase) setMessages(current => current.map(message => message.autonomous?.id === reply.id
        ? { ...message, autonomous: updated.purchase, text: updated.message } : message))
      setRequestHistoryRevision(value => value + 1)
      setWalletNotice('Đã lưu đồng ý nhận NFT demo thay thế. Không thanh toán lại.')
      setDeliveryRecoveryRevision(value => value + 1)
    } catch (error) { setWalletNotice(error instanceof Error ? error.message : 'Chưa thể xác nhận thay thế.') }
    finally { lock.current = false; setBusy(false) }
  }
  function complete(receipt: NftDemoReceipt) {
    if (receipt.status === 'CONFIRMED' || receipt.status === 'FAILED') {
      localStorage.removeItem(pendingKey); setPendingOrder('')
      void refreshBalance()
    }
  }
  async function settleRwa(saved: { requestId: string; text: string; owner: string }) {
    if (saved.owner !== walletRef.current || !walletLinked || !devnetReady) throw new Error('Kết nối và xác minh đúng ví ban đầu trên Devnet để kiểm tra lại.')
    const reply = rwaReplySchema.parse(await investmentApi('/rwa/chat-settle', saved))
    add({ role: 'na', text: reply.message, rwa: reply })
    pendingRwaPrompt.current = reply.status === 'NEEDS_INPUT' ? saved.text : ''
    if (reply.status !== 'PENDING') {
      localStorage.removeItem(pendingKey); localStorage.removeItem(pendingKey + ':rwa'); setPendingOrder('')
    }
    setVaultRevision(value => value + 1); setRequestHistoryRevision(value => value + 1)
    void refreshBalance()
  }
  async function checkOrder() {
    if (lock.current || !pendingOrder || !wallet || !walletLinked) return
    lock.current = true; setBusy(true); setStage('Đang kiểm tra giao dịch trên devnet…')
    try {
      if (localStorage.getItem(pendingKey + ':engine') === 'genuine') {
        if (localStorage.getItem(pendingKey + ':owner') !== wallet) throw new Error('Kết nối đúng ví của đơn đang chờ.')
        showGenuine(await nftPurchaseApi.status(pendingOrder)); return
      }
      if (localStorage.getItem(pendingKey + ':engine') === 'rwa') {
        const saved = JSON.parse(localStorage.getItem(pendingKey + ':rwa') ?? 'null')
        if (!saved || saved.requestId !== pendingOrder) throw new Error('Không tìm thấy nội dung yêu cầu RWA ban đầu.')
        await settleRwa(saved)
        return
      }
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
    if (!request || lock.current) return
    lock.current = true; setBusy(true); setWalletNotice('')
    setStage('Đã nhận tin nhắn. Na đang phân loại yêu cầu…')
    setText(''); add({ role: 'user', text: request })
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
        setStage('Na đang trả lời…')
        const reply = naChatReplySchema.parse(await api('/chat', { text: combinedRequest, conversationId }))
        add({ role: 'na', text: reply.message })
        return
      }
      if (pendingOrder) {
        const reply = naChatReplySchema.parse(await api('/chat', { text: request, conversationId }))
        add({ role: 'na', text: reply.message + '\nĐơn trước vẫn đang chờ kiểm tra; chưa thực hiện thêm giao dịch mua.' })
        return
      }
      const pendingRwa = pendingRwaPrompt.current
      const rwaAmountReply = /^\s*(?:about\s*)?\d+(?:[.,]\d{1,9})?\s*(?:usdc|usd|sol)\s*$/i.test(request)
      // A follow-up amount stays in the RWA flow; anything else is classified by the backend.
      const isRwa = !!pendingRwa && rwaAmountReply ? true : (await classifyAsset(request)).assetType === 'RWA'
      if (isRwa) {
        const rwaText = pendingRwa && rwaAmountReply ? `${pendingRwa} ${request}` : request
        setStage('Na đang kiểm tra registry RWA và quote mainnet…')
        if (wallet && walletLinked && devnetReady) {
          await requireDevnet(devnetConnection())
          const requestId = crypto.randomUUID()
          const saved = { requestId, text: rwaText, owner: wallet }
          localStorage.setItem(pendingKey + ':rwa', JSON.stringify(saved))
          localStorage.setItem(pendingKey + ':engine', 'rwa')
          localStorage.setItem(pendingKey, requestId); setPendingOrder(requestId)
          await settleRwa(saved)
          return
        }
        const rwa = rwaReplySchema.parse(await investmentApi('/rwa/discover', { text: rwaText, ...(wallet ? { owner: wallet } : {}) }))
        pendingRwaPrompt.current = rwa.status === 'NEEDS_INPUT' ? rwaText : ''
        add({ role: 'na', text: rwa.message, rwa })
        return
      }
      if (budgetOnlyReply && !previousIntent && !hasContext) {
        add({ role: 'na', text: 'Bạn muốn tìm hoặc mua NFT nào? Nói tên tranh, bộ sưu tập hoặc chủ đề bạn thích nhé.' })
        return
      }
      if (!hasContext && !hasSolBudget(combinedRequest) && isPurchaseIntent(combinedRequest) && !isCollectionPriceDiscovery(combinedRequest) && !namedNFTQuery(combinedRequest) && !namedNFTPurchaseName(combinedRequest)) {
        pendingPurchaseIntent.current = combinedRequest
        const response = 'Được, mình sẽ tìm theo yêu cầu đó. Bạn muốn giới hạn giá tối đa bao nhiêu SOL? Trả lời tự nhiên, ví dụ “dưới 1 SOL” hoặc “tầm 0.5 SOL”.'
        await api('/requests', { id: crypto.randomUUID(), prompt: request, response, conversationId })
        setRequestHistoryRevision(value => value + 1)
        add({ role: 'na', text: response })
        return
      }
      pendingPurchaseIntent.current = ''
      setStage('Na đang hiểu chủ đề, lấy listing và kiểm tra ngân sách…')
      const discovery = discoveryReplySchema.parse(await api('/discover', { id: crypto.randomUUID(), text: combinedRequest, prompt: request, conversationId, ...(wallet ? { owner: wallet } : {}) }))
      add({ role: 'na', text: discovery.message, discovery })
      if (discovery.intent.priceDiscoveryOnly && discovery.candidates[0] && discovery.candidates[0].sourceNetwork !== 'mainnet') {
        pendingPurchaseIntent.current = combinedRequest
        const price = Number(discovery.candidates[0].listing.priceLamports)
        add({ role: 'na', text: `Giá listing thấp nhất tìm được là ${price / 1e9} SOL, chưa gồm phí. Chưa có tổng chi đã xác minh; Na không tự cộng một khoản phí giả hoặc tăng hạn mức. Bạn có thể nêu mức tối đa bằng SOL để kiểm tra tiếp.` })
      }
    } catch (e) {
      setText(request)
      add({ role: 'na', text: e instanceof Error && e.name === 'TimeoutError'
        ? 'Yêu cầu tới máy chủ quá thời gian chờ. Nếu đang có giao dịch chờ, dùng Kiểm tra giao dịch; không gửi lại lệnh mua. Nếu chưa bắt đầu thanh toán, bạn có thể thử lại.'
        : e instanceof Error ? e.message : 'Không tìm được dữ liệu NFT. Thử lại sau.' })
    } finally {
      setRequestHistoryRevision(value => value + 1)
      lock.current = false; setBusy(false); setStage(''); input.current?.focus()
    }
  }
  function showReconciliation(reply: AutonomousReconciliation) {
    // Reconciliation preserves the original payment and may resume asset delivery.
    if (reply.purchase) add({ role: 'na', text: reply.message, autonomous: reply.purchase })
    else add({ role: 'na', text: reply.message })
    if (reply.status === 'PENDING' || reply.status === 'RECONCILIATION_ERROR') return
    localStorage.removeItem(pendingKey); setPendingOrder('')
    setVaultRevision(value => value + 1)
    void refreshBalance()
  }
  function showGenuine(result: NftPurchaseResult) {
    setMessages(current => [...current.filter(row => row.genuine?.orderId !== result.orderId),
      { id: crypto.randomUUID(), role: 'na', text: '', restoredOwner: localStorage.getItem(pendingKey + ':owner') || walletRef.current, genuine: result }])
    if (genuineDeliveryVerified(result) || !['PENDING', 'CONFIRMED', 'RECONCILIATION_ERROR'].includes(result.status)) {
      localStorage.removeItem(pendingKey); setPendingOrder(''); setVaultRevision(value => value + 1)
    }
  }
  useEffect(() => {
    if (!pendingOrder || !wallet || !walletLinked || localStorage.getItem(pendingKey + ':engine') !== 'genuine') return
    if (localStorage.getItem(pendingKey + ':owner') !== wallet) return
    let active = true, running = false
    const poll = async () => {
      if (running || !active) return
      running = true
      try {
        const result = await nftPurchaseApi.status(pendingOrder)
        if (active && walletRef.current === wallet) showGenuine(result)
      } catch { /* Preserve the original order on RPC/HTTP uncertainty. */ }
      finally { running = false }
    }
    void poll(); const timer = window.setInterval(() => void poll(), 5000)
    return () => { active = false; window.clearInterval(timer) }
  }, [pendingOrder, wallet, walletLinked, pendingKey])
  return <main className="na-chat-app">
    <header className="chat-header"><a href="/na" className="chat-brand">na<span>·</span></a><div className="chat-title"><strong>Người bạn mua sắm</strong><span>{discoveryMode}</span></div>
      <Link className="chat-account" to="/account">Tài khoản &amp; địa chỉ</Link>
      <button className="chat-wallet" disabled={busy} onClick={() => void walletButton()}>{wallet ? `${wallet.slice(0, 4)}…${wallet.slice(-4)}` : 'Kết nối Phantom'}</button>
      <button className="chat-logout" disabled={busy} onClick={() => void account.logout()} title="Đăng xuất khỏi GoBuy" aria-label="Đăng xuất khỏi GoBuy">
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
    <section className="chat-network-note" aria-label="Thông tin giao dịch demo">
      <details><summary>Devnet demo · NFT &amp; RWA</summary>
        <p>Na dùng ngân sách đã ủy quyền. NFT nhận được là GoBuy DEMO, không phải NFT gốc; RWA không đại diện tài sản thật. Ghi “chỉ tìm” để xem đề xuất mà không chi SOL.</p>
      </details>
    </section>
    <section className="chat-utility-panels" aria-label="Bảng điều khiển Na">
      <NaConsole
        walletConnected={!!wallet}
        budget={<NaVaultPanel revision={vaultRevision} wallet={wallet} devnetReady={devnetReady} onChanged={() => void refreshBalance()}/>}
        assets={<WalletPortfolioPanel key={wallet} revision={requestHistoryRevision}/>}
        history={<RequestHistory key={wallet} revision={requestHistoryRevision} onOpen={request => void openHistory(request)} opening={busy}/>}/>
    </section>
    <div className="chat-feed" ref={feed} role="log" aria-label="Cuộc trò chuyện với Na" aria-live="polite">
      {!visibleMessages.length && <section className="chat-welcome"><span className="chat-orbit">✳</span><h1>Bạn muốn tìm NFT nào?</h1><p>Nói chủ đề và ngân sách SOL.<br/>Na kiểm tra listing và mandate, thanh toán bằng SOL Devnet rồi giao tài sản vào ví đã liên kết. Chỉ báo hoàn tất sau khi xác minh nhận tài sản trên chain. RWA demo không đại diện quyền sở hữu RWA thật.</p>
        <div className="chat-prompts">{['Find me an ocean-themed NFT under 1 SOL.', 'Tìm tranh NFT về mèo dưới 0.5 SOL'].map(prompt => <button key={prompt} onClick={() => { setText(prompt); input.current?.focus() }}>{prompt}<span>↗</span></button>)}</div>
      </section>}
      {visibleMessages.map(message => <article key={message.id} className={`chat-message ${message.role}`}>
        {message.role === 'na' && <span className="chat-avatar">na·</span>}
        <div className="chat-bubble"><p>{message.text}</p>
          {message.order && <RestoredOrderStatus order={message.order}/>}
          {message.rwa && <RwaOrderDetails reply={message.rwa} busy={busy} onEvaluate={id => void evaluateRwaOrder(message.id, id)}/>}
          {message.rwa && <section className="chat-rwa-result" aria-label="Thông tin RWA">
            {message.rwa.signature && <a href={explorerTx(message.rwa.signature)} target="_blank" rel="noreferrer">Xem khoản chi demo Devnet ↗</a>}
            {message.rwa.asset && <><strong>{message.rwa.asset.name} ({message.rwa.asset.symbol})</strong>
              <p>{message.rwa.asset.category} · Issuer: {message.rwa.asset.issuer}</p>
              <p>Underlying: {message.rwa.asset.underlying}</p>
              <p>Registry: <a href={message.rwa.asset.verificationSource} target="_blank" rel="noreferrer">nguồn xác minh</a></p></>}
            {message.rwa.quote && <><p>Quote mainnet: {message.rwa.quote.inAmount} input units → {message.rwa.quote.minOutput} output units tối thiểu.</p>
              <p>Route: {message.rwa.quote.route.join(' → ')} · Slippage: {message.rwa.quote.slippageBps} bps</p>
              <p>Đây chỉ là báo giá Solana mainnet. Chưa chuẩn bị hoặc gửi giao dịch; swap thật đang bị tắt.</p></>}
            {message.rwa.referencePrices?.map((price, index) => <article key={`${price.chain}:${price.pair}:${index}`} style={{ borderBottom: '1px solid #d9e5f5', padding: '12px 0', overflowWrap: 'anywhere' }}>
              <strong>{price.symbol} · {price.chain}</strong>
              <p>{price.priceUsd === null ? 'Chưa có giá USD hợp lệ' : `Giá tham khảo: $${price.priceUsd} USD/token`}</p>
              <p>Địa chỉ token: {price.mint}</p>
              <a href={price.url} target="_blank" rel="noopener noreferrer">Xem pool trên Dex Screener ↗</a>
              <p className="candidate-warning">Chưa xác minh RWA · Chỉ tham khảo, không thể mua qua Na.</p>
            </article>)}
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
            {!message.discovery.candidates.length && message.discovery.intent.action === 'BUY' && <p className="candidate-warning">Không tìm được listing NFT phù hợp đang bán. Chưa mua tài sản và không tạo NFT DEMO thay thế.</p>}
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
                <GenuineNftPurchase discovery={message.discovery!} candidate={candidate} owner={wallet}
                  ready={!!wallet && walletLinked && devnetReady} disabled={busy || !!pendingOrder} storageScope={pendingKey}
                  onPending={() => { if (localStorage.getItem(pendingKey)) throw new Error('Đơn trước đang chờ đối soát. Không mua thêm.'); localStorage.setItem(pendingKey + ':engine', 'genuine'); localStorage.setItem(pendingKey + ':owner', wallet); localStorage.setItem(pendingKey, message.discovery!.id); setPendingOrder(message.discovery!.id) }}
                  onResult={showGenuine}/>
              </div>
            </div>)}
          </div>}
          {message.genuine && <GenuinePurchaseResult result={message.genuine}/>}
          {message.autonomous && <AutonomousSpendDetails reply={message.autonomous} onDemoReplacement={() => void acceptDemoReplacement(message.autonomous!)} canRecover={!!wallet && walletLinked && !busy}/>}
          {message.quote && <div className="chat-art"><img src={message.quote.image} alt={message.quote.title}/><div><small>DEVNET SIMULATION</small><h3>{message.quote.title}</h3><strong>{message.quote.priceLamports / 1e9} SOL thử nghiệm</strong><p>Phí đã được tính trong tổng dự kiến ở trên. Không mua NFT gốc.</p></div></div>}
          {message.receipt?.signature && <code className="transaction-signature">{message.receipt.signature}</code>}
          {message.receipt?.signature && <a className="chat-receipt" href={explorerTx(message.receipt.signature)} target="_blank" rel="noreferrer">Xem giao dịch devnet ↗</a>}
          {message.receipt?.status === 'CONFIRMED' && message.receipt.asset && <a className="chat-receipt" href={explorerAccount(message.receipt.asset)} target="_blank" rel="noreferrer">Xem NFT trong ví ↗</a>}
        </div>
      </article>)}
      {stage && <p className="chat-progress" role="status"><span/>{stage}</p>}
    </div>
    <div className="chat-bottom">
      {busy && <p className="chat-hint" role="status">{stage || 'Na đang xử lý, vui lòng chờ…'}</p>}
      {pendingOrder && <div className="chat-pending">{!wallet
        ? 'Tài khoản có một đơn cũ chưa hoàn tất. Kết nối đúng ví để xem trạng thái.'
        : !walletLinked ? 'Xác minh liên kết ví để kiểm tra đơn cũ.'
        : 'Một đơn trước đó đang chờ kiểm tra. Na tạm dừng mua mới.'}
        {wallet && walletLinked && <button disabled={busy} onClick={() => void checkOrder()}>Kiểm tra giao dịch</button>}
      </div>}
      <form className="chat-composer" onSubmit={submit}>
        <label className="sr-only" htmlFor="na-input">Tin nhắn cho Na</label>
        <textarea id="na-input" ref={input} value={text} maxLength={2000} rows={2} placeholder="Ví dụ: Tìm tranh NFT về biển dưới 1 SOL"
          onChange={e => setText(e.target.value)} onKeyDown={e => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229) { e.preventDefault(); e.currentTarget.form?.requestSubmit() }
          }}/>
        <button className="chat-send" aria-label="Gửi tin nhắn" disabled={busy || !text.trim()} type="submit">↑</button>
      </form><p className="chat-hint">Enter để gửi · Shift + Enter để xuống dòng · Không dùng SOL thật</p>
    </div>
  </main>
}

/** True when a saved request carries an order, so its status is worth restoring. */
function hasSavedOrder(request: NaRequest) {
  return !!(request.phase || request.orderId || request.signature)
}

/**
 * The recorded status of a reopened order.
 *
 * It reads only what the database already stored: restoring history must never re-verify, retry or
 * resubmit anything, so an uncertain order keeps saying it is awaiting review.
 */
function RestoredOrderStatus({ order }: { order: NaRequest }) {
  const label = order.phase ? purchasePhaseLabel[order.phase] : statusLabel[order.status]
  return <section className="chat-restored-order" aria-label="Trạng thái đơn đã lưu">
    <strong>Đơn đã lưu · {label}</strong>
    {order.title && <p>{order.title}</p>}
    <p>Trạng thái ghi nhận lúc mở lại. Na không gửi lại giao dịch; dùng “Kiểm tra giao dịch” cho đơn đang chờ.</p>
    {order.signature && <a href={explorerTx(order.signature)} target="_blank" rel="noreferrer">Xem giao dịch devnet ↗</a>}
  </section>
}

function AutonomousSpendDetails({ reply, onDemoReplacement, canRecover }: { reply: AutonomousPurchaseResult; onDemoReplacement: () => void; canRecover: boolean }) {
  const { result } = reply
  const sol = (value: string | undefined | null) => value == null ? 'Unavailable' : (Number(value) / 1e9).toFixed(9) + ' SOL'
  return <section aria-label="Devnet autonomous spend demo">
    <strong>{reply.execution}</strong><p>Selected: {reply.selected.name}</p>
    <p>Listing: {reply.selected.marketplaceListing.listingId}</p>
    <p>Listing price: {sol(reply.listingPriceLamports)} · Actual demo spend: {sol(reply.actualSpendLamports)}</p>
    {result.signature && (reply.actualSpendLamports !== null || reply.delivery?.payment?.status === 'confirmed')
      && <p>Na đã thanh toán {Number(reply.actualSpendLamports ?? reply.requestedSpendLamports) / 1e9} SOL Devnet.</p>}
    {reply.delivery && <>
      {reply.delivery.replacementAcceptedAt && <p>Recovery approved · Đã xác nhận nhận NFT demo thay thế. {reply.phase === 'COMPLETED' ? 'Delivered · Đã giao' : reply.delivery.recovery?.status === 'requires_attention' ? 'Requires attention · Cần kiểm tra' : 'Mint pending · Chờ tạo và giao NFT demo'}</p>}
      <p>Ví nhận: <code>{reply.delivery.recipientWallet ?? reply.delivery.owner}</code></p>
      {reply.delivery.demoName && <p>{reply.delivery.demoName} · NFT mô phỏng, không phải tài sản marketplace gốc.</p>}
      {reply.delivery.mint && <a href={explorerAccount(reply.delivery.mint)} target="_blank" rel="noreferrer">Mint NFT Devnet: {reply.delivery.mint}</a>}
    </>}
    {reply.phase !== 'COMPLETED' && result.signature && reply.actualSpendLamports !== null && reply.deliveryMode !== 'DEVNET_DEMO_MINT' && ['TRANSFER_NFT', 'ORIGINAL_NFT_TRANSFER'].includes(reply.delivery?.deliveryMode ?? '') && <div className="chat-pending">
      <p>Bạn có thể đồng ý nhận một NFT GoBuy DEMO mô phỏng thay cho NFT gốc. Cần ký xác nhận bằng đúng ví đã mua; không thanh toán lại.</p>
      <p>Awaiting consent · Chờ xác nhận thay thế</p>
      <button disabled={!canRecover} onClick={onDemoReplacement}>Nhận NFT demo thay thế</button>
    </div>}
    <p>Mandate PDA: {result.mandate?.address ?? result.spend?.mandate ?? 'Unavailable'} · {result.mandate?.status}</p>
    <p>Vault PDA: {result.mandate?.vault ?? 'Unavailable'}</p>
    <p>Spent before: {sol(result.spend?.spentBeforeLamports)} · Spent after: {sol(result.spend?.spentAfterLamports)}</p>
    <p>Remaining budget: {sol(result.mandate?.remainingLamports)}</p>
    <p>Signed by: {reply.signedBy} · Phantom signature required: No</p>
    <p>Status: {reply.delivery ? deliveryStatusLabel(reply.delivery) : reply.phase ? purchasePhaseLabel[reply.phase] : result.status}{result.rejection ? ' · ' + result.rejection : ''}</p>
    {reply.delivery?.recovery?.nextRetryAt && <p>Lần kiểm tra tiếp theo: {new Date(reply.delivery.recovery.nextRetryAt).toLocaleTimeString('vi-VN')}</p>}
    {reply.delivery?.recovery?.lastError && <p>Chi tiết: {reply.delivery.recovery.lastError}</p>}
    {reply.delivery?.signature && <a href={explorerTx(reply.delivery.signature)} target="_blank" rel="noreferrer">Giao dịch giao NFT Devnet ↗</a>}
    {result.signature && <><code>{result.signature}</code><a href={explorerTx(result.signature)} target="_blank" rel="noreferrer">Giao dịch thanh toán Devnet ↗</a></>}
  </section>
}
