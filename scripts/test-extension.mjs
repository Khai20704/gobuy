import assert from 'node:assert/strict'
import { mkdir, mkdtemp, cp, readFile, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { chromium } from '@playwright/test'
import { createApp } from '../backend/src/app.ts'
import { NaResearchService } from '../backend/src/application/NaResearchService.ts'
import { IntentExtractor } from '../backend/src/services/ai/intentExtractor.ts'
import { SearchAggregator } from '../backend/src/services/search/SearchAggregator.ts'
import { MockSneakerProvider } from '../backend/src/services/search/MockSneakerProvider.ts'
import { MemoryTwinStore } from '../backend/src/services/twin/TwinStore.ts'

const service = new NaResearchService(new IntentExtractor(), new SearchAggregator([new MockSneakerProvider()]), new MemoryTwinStore(), { mode: 'mock' })
const server = createApp(undefined, service).listen(0, '127.0.0.1')
await new Promise(resolve => server.once('listening', resolve))
const api = `http://127.0.0.1:${server.address().port}`
await mkdir('test-results', { recursive: true })
const scratch = await mkdtemp(resolve('test-results/extension-smoke-'))
const extensionPath = join(scratch, 'extension')
let context
try {
  await cp('extension/dist', extensionPath, { recursive: true })
  const manifestPath = join(extensionPath, 'manifest.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  const original = new URL(manifest.host_permissions[0].replace(/\*$/, '')).origin
  manifest.host_permissions = [api + '/*']
  manifest.content_security_policy.extension_pages = `script-src 'self'; object-src 'none'; connect-src ${api}`
  await writeFile(manifestPath, JSON.stringify(manifest))
  const worker = join(extensionPath, 'background/service-worker.js')
  await writeFile(worker, (await readFile(worker, 'utf8')).replaceAll(original, api))
  context = await chromium.launchPersistentContext(join(scratch, 'profile'), {
    channel: process.env.PLAYWRIGHT_CHANNEL || 'msedge', headless: true,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
    viewport: { width: 400, height: 900 },
  })
  const background = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker', { timeout: 20000 })
  const id = new URL(background.url()).host
  const page = await context.newPage(), errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(`chrome-extension://${id}/popup.html`)
  const issued = await fetch(api + '/api/research/pair-code', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
  const { code } = await issued.json()
  await page.getByLabel('One-time pairing code').fill(code)
  await page.getByRole('button', { name: 'Connect', exact: true }).click()
  try { await page.getByLabel('Your request', { exact: true }).waitFor({ timeout: 15000 }) }
  catch (error) { console.error('Popup state:', await page.locator('body').innerText()); throw error }
  await page.getByLabel('Your request', { exact: true }).fill('Find Jordan 1 under 200 USD')
  await page.getByRole('button', { name: 'Search with Na', exact: true }).click()
  await page.getByRole('heading', { name: 'NO MATCH' }).waitFor({ timeout: 15000 })
  await page.screenshot({ path: 'test-results/na-extension-popup.png', fullPage: true })
  await page.close()
  const panel = await context.newPage()
  panel.on('pageerror', error => errors.push(error.message))
  await panel.goto(`chrome-extension://${id}/sidepanel.html`)
  await panel.getByLabel('Your request', { exact: true }).waitFor()
  await panel.getByLabel('Your request', { exact: true }).fill('Jordan 1')
  await panel.getByLabel('Use structured search (no AI required)').check()
  await panel.getByLabel('Maximum for this request').fill('300')
  await panel.getByRole('button', { name: 'Search with Na', exact: true }).click()
  await panel.getByRole('heading', { name: 'Best valid match' }).waitFor({ timeout: 15000 })
  assert.match(await panel.locator('article').first().innerText(), /242 USD/)
  await panel.getByRole('button', { name: 'Inspect current page' }).click()
  await panel.getByRole('alert').waitFor()
  assert.match(await panel.getByRole('alert').innerText(), /not supported/)
  await panel.getByRole('button', { name: 'Load action history' }).click()
  await panel.getByText('NO_MATCH', { exact: true }).waitFor()
  await panel.screenshot({ path: 'test-results/na-extension-sidepanel.png', fullPage: true })
  assert.deepEqual(errors, [])
  console.log('Extension smoke passed: real MV3 load, pairing, popup search, persistent session, side-panel component, structured budget, unsupported page, action history.')
} catch (error) {
  for (const page of context?.pages() ?? []) {
    if (page.url().startsWith('chrome-extension://')) console.error('Extension UI:', await page.locator('body').innerText().catch(() => 'Page unavailable'))
  }
  throw error
} finally {
  await context?.close()
  await new Promise(resolve => server.close(resolve))
}
