import { expect, test } from '@playwright/test'
test('API-backed demo, mandate editing, routes and audit labels', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto('/')
  await expect(page).toHaveURL(/\/na$/)
  await expect(page.getByText('● DEMO MODE', { exact: true })).toBeVisible()
  await page.getByLabel('Your request to Na').fill('Find a quiet artwork')
  await page.getByRole('button', { name: 'Send request', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Quiet forms / Study 08' })).toBeVisible()
  await expect(page.getByText('APPROVED', { exact: true })).toHaveCount(0)
  await expect(page.getByText('REJECTED', { exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: /Record demo rule preview/ })).toBeEnabled()
  await page.evaluate(() => window.scrollTo(0, 0))
  await page.screenshot({ path: 'test-results/na-desktop.png', fullPage: true })
  await page.getByRole('button', { name: /Record demo rule preview/ }).click()
  await expect(page).toHaveURL(/\/na\/activity$/)
  await expect(page.getByText('DEMO PREVIEW · RULES_MATCH')).toBeVisible()
  await expect(page.locator('a[href*="explorer.solana.com/tx/"]')).toHaveCount(0)
  await page.getByRole('link', { name: /My mandate/ }).click()
  await page.getByLabel('Maximum value (integer lamports)').fill('1')
  await page.getByRole('button', { name: /Save demo boundaries/ }).click()
  await expect(page.getByText('v2', { exact: true })).toBeVisible()
  await page.getByRole('link', { name: /Talk to Na/ }).click()
  await page.getByRole('button', { name: /Record demo rule preview/ }).click()
  await expect(page.getByText('DEMO PREVIEW · PRICE_EXCEEDED')).toBeVisible()
  expect(errors).toEqual([])
})
test('image upload, RWA read-only, API failure and mobile wallet access', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/na')
  await expect(page.getByRole('button', { name: 'Connect Phantom' })).toBeVisible()
  await page.locator('input[type=file]').setInputFiles({
    name: 'reference.png', mimeType: 'image/png',
    buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1sAAAAASUVORK5CYII=', 'base64'),
  })
  await page.getByLabel('Demo scenario').selectOption('rwa')
  await page.getByRole('button', { name: 'Send request', exact: true }).click()
  await expect(page.getByText('RWA data is read-only.', { exact: false })).toBeVisible()
  await page.evaluate(() => window.scrollTo(0, 0))
  await page.screenshot({ path: 'test-results/na-mobile.png', fullPage: true })
  await expect(page.getByRole('button', { name: /Send proposal to Na/ })).toHaveCount(0)
  await page.route('**/api/proposals/search', route => route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":{"message":"API unavailable"}}' }))
  await page.getByLabel('Your request to Na').fill('Try again')
  await page.getByRole('button', { name: 'Send request', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('API unavailable')
  await expect(page.getByText('APPROVED', { exact: true })).toHaveCount(0)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
})

test('Phantom connects and disconnects independently of deployment', async ({ page }) => {
  await page.addInitScript(() => {
    let requestedSignature = false
    const publicKey = { toBase58: () => '11111111111111111111111111111111' } // Test-only wallet stub; never sent to RPC.
    Reflect.set(window, 'phantom', { solana: {
      isPhantom: true, publicKey,
      connect: async () => ({ publicKey }), disconnect: async () => {},
      on: () => {}, removeListener: () => {},
      signTransaction: async () => { requestedSignature = true; throw new Error('Signing must not run in demo mode') },
    } })
    Reflect.set(window, 'testSignatureRequested', () => requestedSignature)
  })
  await page.goto('/na')
  await page.getByRole('button', { name: 'Connect Phantom' }).click()
  await expect(page.getByRole('status')).toContainText('Wallet connected. On-chain verification is not set up yet.')
  await expect(page.getByRole('button', { name: /Connected:/ })).toBeVisible()
  await expect(page.getByText('● DEMO MODE', { exact: true })).toBeVisible()
  expect(await page.evaluate(() => Reflect.get(window, 'testSignatureRequested')())).toBe(false)
  await expect(page.getByText('APPROVED', { exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Connect Phantom', exact: true })).toBeVisible()
})

test('missing Phantom shows actionable setup instructions', async ({ page }) => {
  await page.goto('/na')
  await page.getByRole('button', { name: 'Connect Phantom' }).click()
  await expect(page.getByRole('alert')).toContainText('Phantom was not detected')
  await expect(page.getByRole('link', { name: /Get Phantom from the official website/ })).toHaveAttribute('href', 'https://phantom.com/')
  await expect(page.getByRole('button', { name: 'Connect Phantom' })).toBeEnabled()
})

test('detects a late-injected legacy Phantom provider without reloading', async ({ page }) => {
  await page.goto('/na')
  await page.evaluate(() => {
    const publicKey = { toBase58: () => '11111111111111111111111111111111' }
    const listeners = new Map<string, () => void>()
    Reflect.set(window, 'solana', {
      isPhantom: true, publicKey, connect: async () => ({ publicKey }),
      on: (event: string, callback: () => void) => listeners.set(event, callback),
      removeListener: (event: string) => listeners.delete(event),
    })
    Reflect.set(window, 'testWalletChange', () => listeners.get('accountChanged')?.())
  })
  await page.getByRole('button', { name: 'Connect Phantom' }).click()
  await expect(page.getByRole('button', { name: /Connected:/ })).toBeVisible()
  await page.evaluate(() => Reflect.get(window, 'testWalletChange')())
  await expect(page.getByRole('button', { name: 'Connect Phantom' })).toBeVisible()
})
test('Phantom connection rejection surfaces an error without an authorization result', async ({ page }) => {
  await page.addInitScript(() => Reflect.set(window, 'phantom', { solana: {
    isPhantom: true, publicKey: null, on: () => {}, removeListener: () => {},
    connect: async () => { throw new Error('User rejected Phantom connection') },
  } }))
  await page.goto('/na')
  await page.getByRole('button', { name: 'Connect Phantom' }).click()
  await expect(page.getByRole('alert')).toContainText('User rejected Phantom connection')
  await expect(page.getByText('APPROVED', { exact: true })).toHaveCount(0)
  await expect(page.locator('a[href*="explorer.solana.com/tx/"]')).toHaveCount(0)
})
