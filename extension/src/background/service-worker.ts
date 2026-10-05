import { z } from 'zod'
import { researchRequestSchema } from '@gobuy/shared'
import { backendRequest, pairedSessionSchema } from '../lib/providers'
import { supportedPage, validatePageContext } from '../lib/page-context'
import { extractPageContext } from '../content/content-script'
import { walletReviewUrl } from '../lib/solana'

const envelope = z.object({ type: z.enum(['pair', 'search', 'job', 'actions', 'context', 'openWeb', 'disconnect', 'state']), body: z.unknown().optional() }).strict()
chrome.runtime.onMessage.addListener((raw, sender, reply) => {
  // No content-script/page messages may access API credentials or privileged actions.
  if (sender.id !== chrome.runtime.id || !['popup.html', 'sidepanel.html'].some(p => sender.url === chrome.runtime.getURL(p))) return false
  void (async () => {
    const { type, body } = envelope.parse(raw)
    if (type === 'openWeb') return chrome.tabs.create({ url: walletReviewUrl(__WEB_ORIGIN__).url })
    if (type === 'context') {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
      if (tab?.id === undefined || !tab.url || !supportedPage(tab.url)) throw new Error('This page is not supported. Open Magic Eden, Ondo, eBay or Nike, then invoke Na again.')
      const [result] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: extractPageContext })
      return validatePageContext(result?.result)
    }
    if (type === 'pair') {
      const code = z.object({ code: z.string().regex(/^[a-f0-9]{32}$/) }).strict().parse(body)
      const session = pairedSessionSchema.parse(await backendRequest('/pair', 'POST', code))
      await chrome.storage.session.set({ session })
      return { connected: true, expiresAt: session.expiresAt }
    }
    const session = pairedSessionSchema.safeParse((await chrome.storage.session.get('session')).session)
    const valid = session.success && Date.parse(session.data.expiresAt) > Date.now()
    if (type === 'state') return { connected: valid }
    if (!valid) throw new Error('Connect Na using a pairing code from GoBuy. Open Your mandate in the web app.')
    if (type === 'disconnect') {
      try { await backendRequest('/session', 'DELETE', undefined, session.data.token) }
      finally { await chrome.storage.session.remove(['session', 'conversation', 'pendingJob']) }
      return null
    }
    if (type === 'search') {
      const job = z.object({ jobId: z.uuid() }).parse(await backendRequest('/jobs', 'POST', researchRequestSchema.parse(body), session.data.token))
      await chrome.storage.session.set({ pendingJob: job.jobId })
      return job
    }
    if (type === 'job') return backendRequest('/jobs/' + z.uuid().parse(body), 'GET', undefined, session.data.token)
    return backendRequest('/actions', 'GET', undefined, session.data.token)
  })().then(value => reply({ ok: true, value })).catch(error => reply({ ok: false, error: error instanceof z.ZodError ? 'Invalid request data.'
    : error instanceof Error ? error.message : 'Na is temporarily unavailable.' }))
  return true
})
