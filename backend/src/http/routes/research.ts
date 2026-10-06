import type { ExtensionSessions } from '../extensionSessions.js'
import { randomBytes, createHash } from 'node:crypto'
import { Router } from 'express'
import { researchRequestSchema, decisionInputSchema, decisionResponseSchema, twinPreferencesSchema } from '@gobuy/shared'
import type { NaResearchService } from '../../application/NaResearchService.js'
import { InputError } from '../../schemas/search.js'
import { isAllowedOrigin } from '../originGuard.js'

export function researchRoutes(service: NaResearchService, allowedOrigins: string[] = [], sessions?: ExtensionSessions) {
  const router = Router()
  router.use((request, response, next) => {
    if (response.locals.extensionAuthenticated) { next(); return }
    // Same-origin, cookie-isolated anonymous workspace. No wallet address is treated as authentication.
    // A cross-site request is normal: the deployed frontend lives on a different domain, so Origin
    // decides, never Sec-Fetch-Site.
    if (!isAllowedOrigin(request, allowedOrigins)) {
      response.status(403).json({ error: { code: 'ORIGIN_DENIED', message: 'Use the GoBuy app on this origin.' } }); return
    }
    const cookie = request.headers.cookie?.split(';').map(part => part.trim()).find(part => part.startsWith('gobuy_twin='))?.slice(11)
    const token = cookie && /^[a-f0-9]{64}$/.test(cookie) ? cookie : randomBytes(32).toString('hex')
    if (token !== cookie) response.cookie('gobuy_twin', token, { httpOnly: true, sameSite: 'strict', secure: request.secure, path: '/api/research', maxAge: 365 * 24 * 60 * 60_000 })
    response.locals.twinSession = createHash('sha256').update(token).digest('hex')
    next()
  })
  router.post('/pair-code', (_request, response) => {
    if (!sessions || response.locals.extensionAuthenticated) { response.sendStatus(404); return }
    response.json(sessions.issue(response.locals.twinSession))
  })
  router.delete('/extension-sessions', (_request, response) => {
    if (!sessions || response.locals.extensionAuthenticated) { response.sendStatus(404); return }
    sessions.revokeSession(response.locals.twinSession); response.sendStatus(204)
  })
  router.get('/actions', async (_request, response) => { response.json(await service.getActions(response.locals.twinSession)) })
  router.get('/twin', async (_request, response) => { response.json(await service.getTwin(response.locals.twinSession)) })
  router.patch('/twin', async (request, response) => {
    const parsed = twinPreferencesSchema.safeParse(request.body)
    if (!parsed.success) throw new InputError('Invalid Commerce Twin preferences.')
    response.json(await service.setPreferences(response.locals.twinSession, parsed.data))
  })
  router.post('/search', async (request, response) => {
    const parsed = researchRequestSchema.safeParse(request.body)
    if (!parsed.success) throw new InputError('Enter a shopping request of 1–2000 characters. Product research currently accepts text only.')
    response.json(await service.search(response.locals.twinSession, parsed.data.text, parsed.data.previousSearchId, parsed.data.structuredIntent, parsed.data.pageContext))
  })
  router.post('/decisions', async (request, response) => {
    const parsed = decisionInputSchema.safeParse(request.body)
    if (!parsed.success) throw new InputError('Invalid recommendation decision.')
    response.json(decisionResponseSchema.parse(await service.decide(response.locals.twinSession, parsed.data)))
  })
  return router
}
