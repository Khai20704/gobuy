import { expect, type Page, type APIRequestContext } from '@playwright/test'

// Real Firebase Auth emulator flow; no application auth bypass or production fixture token.
export async function readyAccount(page: Page, request: APIRequestContext) {
  const email = `wallet-${crypto.randomUUID()}@example.com`, password = 'Local-test-password!123'
  const phoneNumber = '+1650555' + String(Math.floor(1000 + Math.random() * 8999))
  const base = 'http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/'
  const signup = await (await request.post(base + 'accounts:signUp?key=demo-api-key', { data: { email, password, returnSecureToken: true } })).json()
  const verification = await (await request.post(base + 'accounts:sendVerificationCode?key=demo-api-key', { data: { phoneNumber } })).json()
  const codes = await (await request.get('http://127.0.0.1:9099/emulator/v1/projects/demo-na/verificationCodes')).json()
  const code = codes.verificationCodes.find((item: { sessionInfo: string }) => item.sessionInfo === verification.sessionInfo).code
  const linked = await (await request.post(base + 'accounts:signInWithPhoneNumber?key=demo-api-key', { data: { idToken: signup.idToken, sessionInfo: verification.sessionInfo, code } })).json()
  const saved = await request.put('/api/account/address', { headers: { Authorization: 'Bearer ' + linked.idToken }, data: {
    recipient: 'Wallet Test', country: 'US', line1: '123 Test Street', line2: '', city: 'Test City', region: 'CA', postalCode: '94016',
  } })
  expect(saved.status()).toBe(200)
  await page.goto('/login')
  await page.getByLabel('Email', { exact: true }).fill(email)
  await page.getByLabel('Mật khẩu', { exact: true }).fill(password)
  await page.getByRole('button', { name: 'Đăng nhập', exact: true }).click()
  await expect(page).toHaveURL(/\/na$/)
}
