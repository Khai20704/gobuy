import { expect, test } from '@playwright/test'
import { Keypair, SystemProgram, Transaction } from '@solana/web3.js'
import { readyAccount } from './accountFixture'
test.beforeEach(async ({ page, request }) => { await readyAccount(page, request) })

test('purchase intent without a budget is saved and asks for a price limit', async ({ page }) => {
  await page.route('**/api/acquisition/requests', route => route.fulfill({ status: 204 }))
  await page.goto('/na')
  await page.locator('#na-input').fill('Tìm tranh NFT Collector Crypt và mua')
  await page.locator('.chat-send').click()
  await expect(page.getByText(/Bạn muốn giới hạn giá tối đa bao nhiêu SOL/)).toBeVisible()
  await expect(page.locator('#na-input')).toHaveValue('')
  await expect(page.getByText(/Dịch vụ tìm NFT chưa sẵn sàng/)).toHaveCount(0)
})

test('Devnet wallet status, balance and delegated spending', async ({ page }) => {
  let balance = 2430000000
  let purchaseRequests = 0
  await page.route('**/api/nft-demo/chat', async route => {
    purchaseRequests++
    await route.fulfill({ json: { status: 'NO_MATCH', message: 'Test purchase reached backend.' } })
  })
  await page.route('https://api.devnet.solana.com/**', async route => {
    const request = route.request().postDataJSON()
    const context = { slot: 1 }
    let result: unknown
    switch (request.method) {
      case 'getGenesisHash': result = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG'; break
      case 'getBalance': result = { context, value: balance }; break
      default: throw new Error('Unexpected RPC: ' + request.method)
    }
    await route.fulfill({ json: { jsonrpc: '2.0', id: request.id, result } })
  })
  await page.addInitScript(() => {
    const publicKey = { toBase58: () => '11111111111111111111111111111111' }
    Reflect.set(window, 'phantom', { solana: {
      isPhantom: true, publicKey, connect: async () => ({ publicKey }),
      on: () => {}, removeListener: () => {},
      signTransaction: async () => { throw new Error('Must not request signing in this test') },
    } })
  })
  await page.goto('/na')
  await expect(page.getByText('DEVNET', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Thiết lập quyền chi tiêu' }).click()
  await page.getByRole('button', { name: 'Kiểm tra Policy' }).click()
  await expect(page.getByRole('status')).toContainText('Kết nối Phantom')
  await page.locator('.chat-wallet').click()
  await expect(page.getByText('2.4300 Devnet SOL', { exact: true })).toBeVisible()
  await expect(page.getByLabel('Quyền chi tiêu của Agent')).toBeVisible()
  await expect(page.getByText('2.43 SOL', { exact: true })).toBeVisible()
  await expect(page.getByText('0.243 SOL', { exact: true })).toBeVisible()
  await expect(page.getByText('0.729 SOL', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Refresh balance' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Get 1 Devnet SOL' })).toHaveCount(0)
  await page.getByRole('button', { name: 'Thiết lập quyền chi tiêu' }).click()
  await page.getByRole('button', { name: 'Kiểm tra Policy' }).click()
  await expect(page.getByLabel('Quyền chi tiêu của Agent')).toHaveCount(0)
  await expect(page.getByText(/Policy cho phép 0.05 SOL/)).toBeVisible()
  await expect(page.locator('.chat-feed')).toBeVisible()
  expect(await page.locator('.chat-feed').evaluate(element => element.getBoundingClientRect().height)).toBeGreaterThan(200)
  await expect(page.locator('.chat-composer')).toBeVisible()
  await page.locator('#na-input').fill('Mua tranh NFT dưới 1 SOL')
  await page.locator('.chat-send').click()
  await expect(page.getByText(/Yêu cầu của bạn vẫn được giữ trong ô nhập/)).toBeVisible()
  await expect(page.locator('#na-input')).toHaveValue('Mua tranh NFT dưới 1 SOL')
  expect(purchaseRequests).toBe(0)
  await page.getByRole('checkbox').check()
  await expect(page.getByText(/Yêu cầu của bạn vẫn được giữ trong ô nhập/)).toHaveCount(0)
  await page.locator('.chat-send').click()
  await expect(page.getByText('Test purchase reached backend.', { exact: true })).toBeVisible()
  expect(purchaseRequests).toBe(1)
  await page.reload()
  await expect(page.getByLabel('Quyền chi tiêu của Agent')).toHaveCount(0)
})

for (const approve of [true, false]) test(`purchase flow: wallet ${approve ? 'approves and balance refreshes' : 'rejects without submission'}`, async ({ page }) => {
  const owner = Keypair.generate()
  const transaction = new Transaction({ feePayer: owner.publicKey, recentBlockhash: Keypair.generate().publicKey.toBase58() })
    .add(SystemProgram.transfer({ fromPubkey: owner.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 200000000 }))
  let balance = 5e9
  let submissions = 0
  let approvals = 0
  await page.exposeFunction('signTestTransaction', (bytes: number[]) => {
    approvals++
    if (!approve) throw new Error('User rejected the request.')
    const signed = Transaction.from(Buffer.from(bytes))
    signed.partialSign(owner)
    return Array.from(signed.signature!)
  })
  await page.addInitScript(address => {
    const publicKey = { toBase58: () => address }
    Reflect.set(window, 'phantom', { solana: {
      isPhantom: true, publicKey, connect: async () => ({ publicKey }), on: () => {}, removeListener: () => {},
      signTransaction: async (tx: Transaction) => {
        const bytes = await Reflect.get(window, 'signTestTransaction')(Array.from(tx.serialize({ requireAllSignatures: false })))
        tx.addSignature(tx.feePayer!, new Uint8Array(bytes) as never)
        return tx
      },
    } })
  }, owner.publicKey.toBase58())
  await page.route('https://api.devnet.solana.com/**', async route => {
    const request = route.request().postDataJSON()
    const result = request.method === 'getGenesisHash' ? 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG'
      : { context: { slot: 1 }, value: request.method === 'getBalance' ? balance : true }
    await route.fulfill({ json: { jsonrpc: '2.0', id: request.id, result } })
  })
  await page.route('**/api/nft-demo/chat', async route => {
    const request = route.request().postDataJSON()
    await route.fulfill({ json: { status: 'READY', message: 'Test quote', quote: {
      id: request.id, network: 'devnet', owner: owner.publicKey.toBase58(), asset: Keypair.generate().publicKey.toBase58(),
      title: 'Blue Tide', image: '/test.svg', priceLamports: 200000000, maximumLamports: 499999999,
      estimatedTotalLamports: 205000000, transaction: transaction.serialize({ requireAllSignatures: false }).toString('base64'),
      expiresAt: new Date(Date.now() + 90000).toISOString(),
    } } })
  })
  await page.route('**/api/nft-demo/submit', async route => {
    submissions++
    assertSigned(route.request().postDataJSON().transaction)
    balance -= 205000000
    await route.fulfill({ json: { status: 'CONFIRMED', message: 'Test purchase confirmed', signature: 'test-confirmed-signature', totalLamports: 205000000 } })
  })
  function assertSigned(wire: string) { expect(Transaction.from(Buffer.from(wire, 'base64')).verifySignatures()).toBe(true) }
  await page.goto('/na')
  await page.locator('.chat-wallet').click()
  await expect(page.getByText('5.0000 Devnet SOL', { exact: true })).toBeVisible()
  await page.getByRole('checkbox').check()
  await page.locator('#na-input').fill('Mua tranh NFT về biển dưới 0.5 SOL')
  await page.locator('.chat-send').click()
  if (approve) {
    await expect(page.getByText('Test purchase confirmed', { exact: true })).toBeVisible()
    await expect(page.getByText('4.7950 Devnet SOL', { exact: true })).toBeVisible()
    await expect(page.locator('a[href*="/tx/"]')).toHaveAttribute('href', 'https://explorer.solana.com/tx/test-confirmed-signature?cluster=devnet')
    expect(submissions).toBe(1)
    expect(await page.evaluate(() => Object.keys(localStorage).some(key => key.startsWith('na-devnet-pending-order:')))).toBe(false)
  } else {
    await expect(page.getByText('User rejected the request.', { exact: true })).toBeVisible()
    expect(submissions).toBe(0)
    await expect(page.getByText('5.0000 Devnet SOL', { exact: true })).toBeVisible()
    await expect(page.locator('#na-input')).toHaveValue('Mua tranh NFT về biển dưới 0.5 SOL')
  }
  expect(approvals).toBe(1)
})
