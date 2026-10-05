import { build } from 'esbuild'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
const api = new URL(process.env.GOBUY_API_ORIGIN || 'http://localhost:3001')
const web = new URL(process.env.GOBUY_WEB_ORIGIN || 'http://localhost:5173')
for (const url of [api, web]) {
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash
    || !(url.protocol === 'https:' || url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) throw new Error('Use exact HTTPS origins (HTTP allowed only on loopback).')
}
await mkdir('dist', { recursive: true })
const manifest = JSON.parse(await readFile('manifest.json', 'utf8'))
manifest.host_permissions = [api.origin + '/*']
manifest.content_security_policy.extension_pages = `script-src 'self'; object-src 'none'; connect-src ${api.origin}`
await writeFile('dist/manifest.json', JSON.stringify(manifest, null, 2))
await build({ entryPoints: { popup: 'src/popup/Popup.tsx', sidepanel: 'src/sidepanel/SidePanel.tsx',
  'background/service-worker': 'src/background/service-worker.ts' }, outdir: 'dist', bundle: true, format: 'esm',
  platform: 'browser', target: 'chrome116', minify: true, jsx: 'automatic',
  define: { __API_ORIGIN__: JSON.stringify(api.origin), __WEB_ORIGIN__: JSON.stringify(web.origin), 'process.env.NODE_ENV': '"production"' } })
for (const name of ['popup', 'sidepanel']) await writeFile(`dist/${name}.html`, `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Na Commerce Agent</title><link rel="stylesheet" href="${name}.css"></head><body><div id="root"></div><script type="module" src="${name}.js"></script></body></html>`)
