import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { Router } from 'express'
import { z } from 'zod'
import { researchRequestSchema, type ResearchResponse } from '@gobuy/shared'
import type { NaResearchService } from '../application/NaResearchService.js'
import { researchRoutes } from './routes/research.js'

const hash = (s: string) => createHash('sha256').update(s).digest('hex')
type Grant = { session: string; expires: number; origin?: string }
export class ExtensionSessions {
  private readonly codes = new Map<string, Grant>()
  private readonly tokens = new Map<string, Grant>()
  constructor(private readonly now = Date.now) {}
  private prune(map: Map<string, Grant>) { for (const [key, grant] of map) if (grant.expires <= this.now()) map.delete(key) }
  issue(session: string) {
    this.prune(this.codes)
    if (this.codes.size >= 1000) throw new Error('Pairing capacity reached')
    for (const [key, grant] of this.codes) if (grant.session === session) this.codes.delete(key)
    const code = randomBytes(16).toString('hex'), expires = this.now() + 120000
    this.codes.set(hash(code), { session, expires })
    return { code, expiresAt: new Date(expires).toISOString() }
  }
  redeem(code: string, origin: string) {
    this.prune(this.codes); this.prune(this.tokens)
    const grant = this.codes.get(hash(code))
    if (!grant || !/^chrome-extension:\/\/[a-p]{32}$/.test(origin) || this.tokens.size >= 1000) return undefined
    this.codes.delete(hash(code))
    const token = randomBytes(32).toString('hex'), expires = this.now() + 3600000
    this.tokens.set(hash(token), { session: grant.session, origin, expires })
    return { token, expiresAt: new Date(expires).toISOString() }
  }
  authenticate(token: string, origin: string) {
    this.prune(this.tokens)
    const grant = this.tokens.get(hash(token))
    return grant?.origin === origin ? grant.session : undefined
  }
  revoke(token: string) { this.tokens.delete(hash(token)) }
  revokeSession(session: string) { for (const map of [this.codes, this.tokens]) for (const [key, g] of map) if (g.session === session) map.delete(key) }
}

export function extensionRoutes(service: NaResearchService, sessions: ExtensionSessions) {
  const router = Router()
  const jobs = new Map<string, { session: string; expires: number; status: 'PENDING' | 'DONE' | 'FAILED'; result?: ResearchResponse }>()
  router.use((req, res, next) => {
    const origin = req.get('origin') ?? ''
    if (!/^chrome-extension:\/\/[a-p]{32}$/.test(origin)) { res.status(403).json({ error: { message: 'Extension origin required.' } }); return }
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Vary', 'Origin')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
    if (req.method === 'OPTIONS') { res.sendStatus(204); return }
    next()
  })
  router.post('/pair', (req, res) => {
    const code = z.object({ code: z.string().regex(/^[a-f0-9]{32}$/) }).strict().safeParse(req.body)
    const grant = code.success ? sessions.redeem(code.data.code, req.get('origin')!) : undefined
    if (!grant) { res.status(401).json({ error: { message: 'Pairing code invalid or expired. Generate a new code in GoBuy.' } }); return }
    res.json(grant)
  })
  router.use((req, res, next) => {
    const token = req.get('authorization')?.match(/^Bearer ([a-f0-9]{64})$/)?.[1] ?? ''
    const session = sessions.authenticate(token, req.get('origin')!)
    if (!session) { res.status(401).json({ error: { message: 'Connect the extension from GoBuy again.' } }); return }
    res.locals.twinSession = session; res.locals.extensionAuthenticated = true; res.locals.extensionToken = token
    next()
  })
  router.delete('/session', (_req, res) => { sessions.revoke(res.locals.extensionToken); res.sendStatus(204) })
  // Short requests survive MV3 worker suspension; slow provider calls run on the server.
  router.post('/jobs', (req, res) => {
    for (const [id, job] of jobs) if (job.expires <= Date.now()) jobs.delete(id)
    const parsed = researchRequestSchema.safeParse(req.body)
    if (!parsed.success) { res.status(400).json({ error: { message: 'Invalid research request.' } }); return }
    if (jobs.size >= 500 || [...jobs.values()].some(j => j.session === res.locals.twinSession && j.status === 'PENDING')) {
      res.status(409).json({ error: { message: 'Research already in progress or at capacity.' } }); return
    }
    const jobId = randomUUID(), session: string = res.locals.twinSession
    const job: { session: string; expires: number; status: 'PENDING' | 'DONE' | 'FAILED'; result?: ResearchResponse } = { session, expires: Date.now() + 600000, status: 'PENDING' }
    jobs.set(jobId, job)
    const r = parsed.data
    void service.search(session, r.text, r.previousSearchId, r.structuredIntent, r.pageContext)
      .then(result => { job.result = result; job.status = 'DONE' }).catch(() => { job.status = 'FAILED' })
    res.status(202).json({ jobId })
  })
  router.get('/jobs/:id', (req, res) => {
    const job = jobs.get(String(req.params.id))
    if (!job || job.session !== res.locals.twinSession || job.expires <= Date.now()) { res.status(404).json({ error: { message: 'Research expired. Start a new search.' } }); return }
    res.json({ status: job.status, ...(job.result ? { result: job.result } : {}) })
  })
  // Only read/search/review functions are exposed; no signing or policy modification API.
  router.use(researchRoutes(service))
  return router
}
