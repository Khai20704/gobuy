import type { Request, RequestHandler, Response } from 'express'

/**
 * Browser origin gate for the authenticated API routes.
 *
 * `Origin` is the authoritative signal. The production frontend is served from a different domain
 * than this backend, so it legitimately calls it with `Sec-Fetch-Site: cross-site`; that header
 * alone must never deny a request. A request is allowed when it carries no `Origin` at all (curl,
 * server-to-server, same-origin navigation), when its exact origin is listed in APP_ORIGINS, or
 * when it targets this backend's own origin.
 */
export function isAllowedOrigin(request: Request, origins: string[]): boolean {
  const origin = request.get('origin')
  if (!origin) return true
  if (origins.includes(origin)) return true
  // Never '*': only the exact APP_ORIGINS entries above, or this backend's own origin.
  try { return new URL(origin).origin === `${request.protocol}://${request.get('host')}` } catch { return false }
}

/** Applies {@link isAllowedOrigin} and answers with the route's own denial response. */
export function originGuard(origins: string[], deny: (response: Response) => void): RequestHandler {
  return (request, response, next) => {
    if (isAllowedOrigin(request, origins)) { next(); return }
    deny(response)
  }
}
