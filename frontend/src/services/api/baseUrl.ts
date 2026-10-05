/**
 * Single source of truth for the GoBuy API origin.
 *
 * Production (Vercel): VITE_API_BASE_URL is intentionally left empty so every request stays
 * same-origin and is forwarded to the live backend by the `/api/:path*` rewrite in vercel.json.
 * That rewrite is required because the backend's Commerce Twin endpoints (`/api/research/*`)
 * are protected by an httpOnly `gobuy_twin` cookie with `SameSite=Strict` and reject requests
 * whose `sec-fetch-site` header is `cross-site`; a direct cross-origin call to the backend would
 * fail them. Same-origin also avoids depending on the backend's APP_ORIGINS allow-list.
 *
 * Local development: leaves paths relative, so the Vite dev/preview proxy sends them to
 * GOBUY_API_URL (default http://localhost:3001) — see vite.config.ts.
 *
 * Only Firebase Web app configuration and this public origin may use VITE_*; Vite inlines every
 * VITE_* value into the shipped bundle, so never expose backend secrets here.
 */
// Read defensively: `import.meta.env` exists in Vite builds, but not in the node/tsx test runner.
const viteEnv = import.meta.env as unknown as Record<string, string | undefined> | undefined
const configuredBaseUrl = (viteEnv?.VITE_API_BASE_URL ?? '').trim().replace(/\/+$/, '')

export const API_BASE_URL = configuredBaseUrl

/** Resolves an `/api/...` path against the configured backend origin. */
export function apiUrl(path: string): string {
  return API_BASE_URL ? API_BASE_URL + path : path
}
