import { expect, test } from '@playwright/test'
import { Keypair, SystemProgram, Transaction } from '@solana/web3.js'

test('Na Vault shows on-chain budget and a rejected spend without requesting a Phantom transaction', async ({ page }) => {
  page.on('pageerror', error => console.error('Vault browser error:', error.message))
  const owner = Keypair.generate().publicKey.toBase58(), program = Keypair.generate().publicKey.toBase58()
  const mandate = { address: program, owner, executor: program, vault: program, recipient: program,
    maxBudgetLamports: '1000000000', spentLamports: '800000000', remainingLamports: '200000000', vaultLamports: '200890880',
    expiresAt: Math.floor(Date.now() / 1000) + 3600, allowedCategory: 'NFT', active: true, closed: false, createdAt: 1, closedAt: 0, status: 'ACTIVE' }
  await page.route('**/src/features/account/AccountContext.tsx*', route => route.fulfill({ contentType: 'text/javascript', body:
    `export const useAccount=()=>({user:{uid:'vault-fixture'},profile:{ready:true},loading:false,error:''}); export const AccountProvider=({children})=>children;` }))
  await page.route('**/src/features/account/firebase.ts*', route => route.fulfill({ contentType: 'text/javascript', body:
    `export const accountFetch=(path,init)=>fetch(path,init); export const accountAuth=null; export const authMessage=e=>e.message; export const firebaseConfigured=true; export const phoneTestMode=false;` }))
  await page.addInitScript(address => {
    const publicKey = { toBase58: () => address }
    Object.assign(window, { phantom: { solana: { isPhantom: true, publicKey, connect: async () => ({ publicKey }),
      on: () => {}, removeListener: () => {}, signTransaction: async () => { throw new Error('Autonomous spend must not request Phantom signing') } } } })
  }, owner)
  await page.route('https://api.devnet.solana.com/**', route => {
    const input = route.request().postDataJSON()
    return route.fulfill({ json: { jsonrpc: '2.0', id: input.id, result: input.method === 'getBalance'
      ? { context: { slot: 1 }, value: 9000000000 } : 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG' } })
  })
  await page.route('**/api/acquisition/**', route => route.fulfill({ json: route.request().url().endsWith('/config')
    ? { discoveryMode: 'mock', discoveryNetwork: 'devnet' } : route.request().url().endsWith('/wallets') ? [{ address: owner, verified: true }] : [] }))
  let spendRequests = 0
  await page.route(url => url.pathname.startsWith('/api/mandate'), route => {
    const path = new URL(route.request().url()).pathname
    if (path.endsWith('/config')) return route.fulfill({ json: { vaultProgramId: program, autonomousExecutionReady: true,
      categories: ['NFT'], durations: [{ id: 'day', label: '24 hours', hours: 24 }], marketplaceExecution: 'wallet_signature_required' } })
    if (path.endsWith('/spends')) return route.fulfill({ json: { spends: [] } })
    if (path.endsWith('/spend')) {
      spendRequests++
      expect(route.request().postDataJSON().amountLamports).toBe('300000000')
      return route.fulfill({ json: { signature: null, status: 'FAILED', rejection: 'BudgetExceeded', spend: null, mandate,
        message: 'Giao dịch vượt quá hạn mức đã ủy quyền. Ngân sách còn lại: 0.200 SOL.' } })
    }
    return route.fulfill({ json: { mandate, description: 'Vault budget', vaultProgramId: program, marketplaceExecution: 'wallet_signature_required' } })
  })
  await page.goto('/na')
  await page.getByRole('button', { name: 'Kết nối Phantom', exact: true }).click()
  await page.getByLabel('Tôi đã bật Devnet trong Phantom').check()
  const panel = page.getByRole('region', { name: 'Na Vault', exact: true })
  await expect(panel).toContainText('0.200 SOL')
  await expect(panel).toContainText('1.000 SOL')
  await panel.getByText('Demo chi tiêu từ vault (không mua tài sản)', { exact: true }).click()
  await panel.getByLabel('Số SOL', { exact: true }).fill('0.3')
  await panel.getByRole('button', { name: 'Na thực hiện chuyển SOL demo' }).click()
  await expect(panel.getByRole('status')).toContainText('vượt quá hạn mức')
  expect(spendRequests).toBe(1)
  await expect(panel.locator('a[href*="explorer.solana.com/tx/"]')).toHaveCount(0)
  await page.route('**/api/mandate/config', route => route.fulfill({ json: { vaultProgramId: null, 
    autonomousExecutionReady: false, categories: ['NFT', 'RWA', 'ANY'], durations: [{ id: 'day', label: '24 giờ', hours: 24 }, { id: 'week', label: '7 ngày', hours: 168 }],
    marketplaceExecution: 'wallet_signature_required' } }))
  await page.reload()
  await expect(panel).toContainText('Chưa cấu hình chương trình')
  await panel.getByLabel('Ngân sách SOL', { exact: true }).fill('2.5')
  await panel.getByRole('combobox', { name: /Thời hạn/ }).selectOption('168')
  await panel.getByRole('combobox', { name: /Danh mục/ }).selectOption('RWA')
  await expect(panel.getByLabel('Địa chỉ nhận SOL Devnet', { exact: true })).toHaveCount(0)
  await expect(panel.getByLabel('Ngân sách SOL', { exact: true })).toHaveValue('2.5')
  await expect(panel.getByRole('button', { name: 'Ủy quyền 2.5 SOL bằng Phantom' })).toBeDisabled()
})

test('conversation replies and ranking clarification preserve the request without requesting a quote', async ({ page }) => {
  const discoveryTexts: string[] = []
  let quotes = 0
  await page.route('**/src/features/account/AccountContext.tsx*', route => route.fulfill({ contentType: 'text/javascript', body:
    `export const useAccount=()=>({user:{uid:'fixture'},profile:{ready:true},loading:false,error:''}); export const AccountProvider=({children})=>children;` }))
  await page.route('**/src/features/account/firebase.ts*', route => route.fulfill({ contentType: 'text/javascript', body:
    `export const accountFetch=(path,init)=>fetch(path,init); export const accountAuth=null; export const authMessage=e=>e.message; export const firebaseConfigured=true; export const phoneTestMode=false;` }))
  await page.route('**/api/nft-demo/requests', route => route.fulfill({ json: [] }))
  await page.route('https://api.devnet.solana.com/**', route => route.fulfill({ json: { jsonrpc: '2.0', id: route.request().postDataJSON().id,
    result: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG' } }))
  await page.route('**/api/acquisition/**', async route => {
    const path = new URL(route.request().url()).pathname.replace('/api/acquisition', '')
    const data = route.request().method() === 'POST' ? route.request().postDataJSON() : {}
    if (path === '/config') return route.fulfill({ json: { discoveryMode: 'marketplace', discoveryNetwork: 'mainnet' } })
    if (path === '/wallets' || path === '/portfolio') return route.fulfill({ json: [] })
    if (path === '/chat') return route.fulfill({ json: { kind: data.text.includes('số 1') ? 'ranking' : 'question', mode: 'local',
      message: data.text.includes('số 1') ? 'Bạn muốn số 1 theo tiêu chí nào?' : 'NFT là token có định danh riêng trên blockchain.' } })
    if (path === '/discover') {
      discoveryTexts.push(data.text)
      return route.fulfill({ json: { id: data.id, intent: { assetType: 'NFT', semanticQuery: 'Retardio_Cousins', terms: ['retardio', 'cousins'],
        maximumLamports: '999999999', currency: 'SOL', intent: 'acquire_asset', action: 'SEARCH', parser: 'literal' }, status: 'NO_MATCH', sources: [],
        candidates: [], message: 'Đã kiểm tra collection theo giá thấp nhất.', warnings: [], expiresAt: new Date(Date.now() + 120000).toISOString() } })
    }
    if (path === '/quote') quotes++
    return route.fulfill({ status: 400, json: { error: { message: `Unexpected API ${path}` } } })
  })
  await page.goto('/na')
  await page.locator('#na-input').fill('NFT là gì?')
  await page.locator('.chat-send').click()
  await expect(page.locator('.chat-bubble').last()).toContainText('định danh riêng')
  expect(discoveryTexts).toHaveLength(0)
  await page.locator('#na-input').fill('Mua NFT đứng số 1 trong collection Retardio_Cousins dưới 1 SOL')
  await page.locator('.chat-send').click()
  await expect(page.locator('.chat-bubble').last()).toContainText('tiêu chí nào')
  expect(discoveryTexts).toHaveLength(0)
  await page.locator('#na-input').fill('giá thấp nhất')
  await page.locator('.chat-send').click()
  await expect(page.locator('.chat-bubble').last()).toContainText('Đã kiểm tra collection')
  expect(discoveryTexts).toHaveLength(1)
  expect(discoveryTexts[0]).toContain('Retardio_Cousins')
  expect(discoveryTexts[0]).toContain('dưới 1 SOL')
  expect(discoveryTexts[0]).toContain('Chỉ tìm')
  expect(quotes).toBe(0)
})

// Isolated browser integration: auth and external services are replaced at the network boundary.
// No production auth bypass, API secrets, user wallet or mainnet transaction is used.
for (const outcome of ['confirmed', 'rejected', 'pending', 'wrong-network']) test(`acquisition flow: ${outcome}`, async ({ page }) => {
  const owner = Keypair.generate(), mint = Keypair.generate().publicKey.toBase58(), sourceMint = Keypair.generate().publicKey.toBase58()
  let discoveryId = '', verified = false, submitted = false, signingRequests = 0
  const source = { id: 'me:' + sourceMint, provider: 'Magic Eden', sourceNetwork: 'mainnet', mint: sourceMint,
    name: 'Ocean Dreams', description: 'Ocean sea artwork', image: null, collection: 'marine', attributes: [],
    listing: { priceLamports: '720000000', currency: 'SOL', seller: Keypair.generate().publicKey.toBase58(), url: 'https://magiceden.io/item-details/' + sourceMint, observedAt: new Date().toISOString() },
    relevance: 1, reasons: ['Ocean theme matches.'], warnings: [] }
  await page.route('**/src/features/account/AccountContext.tsx*', route => route.fulfill({ contentType: 'text/javascript', body:
    `export const useAccount=()=>({user:{uid:'fixture'},profile:{ready:true},loading:false,error:''}); export const AccountProvider=({children})=>children;` }))
  await page.route('**/src/features/account/firebase.ts*', route => route.fulfill({ contentType: 'text/javascript', body:
    `export const accountFetch=(path,init)=>fetch(path,init); export const accountAuth=null; export const authMessage=e=>e.message; export const firebaseConfigured=true; export const phoneTestMode=false;` }))
  await page.route('**/api/nft-demo/requests', route => route.fulfill({ json: [] }))
  await page.route('**/api/acquisition/**', async route => {
    const path = new URL(route.request().url()).pathname.replace('/api/acquisition', '')
    const data = route.request().method() === 'POST' ? route.request().postDataJSON() : {}
    if (path === '/config') return route.fulfill({ json: { discoveryMode: 'marketplace', discoveryNetwork: 'mainnet' } })
    if (path === '/wallets') return route.fulfill({ json: verified ? [{ address: owner.publicKey.toBase58(), provider: 'phantom', network: 'devnet', verified: true, createdAt: new Date().toISOString(), lastUsedAt: new Date().toISOString() }] : [] })
    if (path === '/portfolio') return route.fulfill({ json: submitted ? [{ id: discoveryId, userId: 'fixture', walletAddress: owner.publicKey.toBase58(), assetType: 'NFT', sourceAsset: source,
      execution: { network: 'devnet', simulated: true, mint, transactionHash: 'fixture-transaction' }, acquisitionPriceLamports: '725000000', acquisitionCurrency: 'DEVNET_SOL', acquisitionDate: new Date().toISOString(), ownership: 'verified', ownershipCheckedAt: new Date().toISOString(),
      valuation: { estimatedMarketValue: null, unrealizedPnL: null, note: 'Devnet simulation has no investment value.' } }] : [] })
    if (path === '/discover') {
      expect(data.text).toContain('ocean'); discoveryId = data.id
      return route.fulfill({ json: { id: discoveryId, intent: { assetType: 'NFT', semanticQuery: 'ocean', terms: ['ocean'], maximumLamports: '999999999', currency: 'SOL', intent: 'acquire_asset', parser: 'llm' },
        candidates: [source], message: 'Found a marketplace candidate.', warnings: [], expiresAt: new Date(Date.now() + 120000).toISOString() } })
    }
    if (path === '/wallets/challenge') return route.fulfill({ json: { id: crypto.randomUUID(), message: 'Fixture ownership proof' } })
    if (path === '/wallets/verify') { verified = true; return route.fulfill({ json: { verified: true } }) }
    if (path === '/quote') {
      expect(verified).toBe(true)
      const tx = new Transaction({ feePayer: owner.publicKey, recentBlockhash: Keypair.generate().publicKey.toBase58() })
        .add(SystemProgram.transfer({ fromPubkey: owner.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 720000000 }))
      return route.fulfill({ json: { status: 'READY', message: 'Devnet simulation only.', quote: { id: discoveryId, owner: owner.publicKey.toBase58(), network: 'devnet', asset: mint, title: source.name, image: '',
        priceLamports: 720000000, maximumLamports: 999999999, estimatedTotalLamports: 725000000, sourceAsset: source, simulated: true,
        transaction: tx.serialize({ requireAllSignatures: false }).toString('base64'), expiresAt: new Date(Date.now() + 90000).toISOString() } } })
    }
    if (path.startsWith('/orders/')) return route.fulfill({ json: { status: 'PENDING', signature: 'fixture-transaction', message: 'Awaiting chain confirmation.' } })
    if (path === '/submit') {
      expect(Transaction.from(Buffer.from(data.transaction, 'base64')).verifySignatures()).toBe(true)
      submitted = true
      if (outcome === 'pending') return route.fulfill({ json: { status: 'PENDING', signature: 'fixture-transaction', message: 'Awaiting chain confirmation.' } })
      return route.fulfill({ json: { status: 'CONFIRMED', message: 'Simulation confirmed; original NFT not acquired.', signature: 'fixture-transaction', asset: mint, totalLamports: 725000000 } })
    }
    throw new Error('Unexpected API: ' + path)
  })
  await page.route('https://api.devnet.solana.com/**', async route => {
    const body = route.request().postDataJSON()
    return route.fulfill({ json: { jsonrpc: '2.0', id: body.id, result: body.method === 'getGenesisHash' ? (outcome === 'wrong-network' ? 'wrong-network' : 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG')
      : { context: { slot: 1 }, value: body.method === 'getBalance' ? 5e9 : true } } })
  })
  await page.exposeFunction('signFixture', (wire: number[]) => {
    signingRequests++
    if (outcome === 'rejected') throw new Error('User rejected the request.')
    const tx = Transaction.from(Buffer.from(wire)); tx.partialSign(owner); return Array.from(tx.signature!)
  })
  await page.addInitScript(address => {
    const publicKey = { toBase58: () => address }
    Reflect.set(window, 'phantom', { solana: { isPhantom: true, publicKey, connect: async () => ({ publicKey }), on: () => {}, removeListener: () => {},
      signMessage: async () => ({ signature: new Uint8Array(64) }),
      signTransaction: async (tx: Transaction) => { tx.addSignature(tx.feePayer!, new Uint8Array(await Reflect.get(window, 'signFixture')(Array.from(tx.serialize({ requireAllSignatures: false })))) as never); return tx },
    } })
  }, owner.publicKey.toBase58())
  await page.goto('/na')
  await page.locator('#na-input').fill('Find me an ocean-themed NFT under 1 SOL.')
  await page.locator('.chat-send').click()
  await expect(page.getByRole('heading', { name: 'Ocean Dreams' })).toBeVisible()
  expect(signingRequests).toBe(0)
  await page.locator('.chat-wallet').click()
  await page.getByRole('checkbox').check()
  await page.getByRole('button', { name: 'Mô phỏng mua trên Devnet' }).click()
  if (outcome === 'rejected') {
    await expect(page.getByText('User rejected the request.', { exact: true })).toBeVisible()
    expect(submitted).toBe(false); expect(signingRequests).toBe(1); return
  }
  if (outcome === 'wrong-network') {
    await expect(page.locator('.chat-bubble').last()).toContainText('different genesis hash')
    expect(submitted).toBe(false); expect(signingRequests).toBe(0); return
  }
  if (outcome === 'pending') {
    await expect(page.locator('.chat-pending')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Mô phỏng mua trên Devnet' })).toBeDisabled()
    expect(signingRequests).toBe(1); return
  }
  await expect(page.getByText('Simulation confirmed; original NFT not acquired.', { exact: true })).toBeVisible()
  expect(signingRequests).toBe(1)
  await page.locator('.asset-portfolio summary').click()
  await expect(page.locator('.asset-portfolio')).toContainText('Ocean Dreams · Devnet Simulation')
  await expect(page.locator('.asset-portfolio')).toContainText('không áp dụng')
  await page.setViewportSize({ width: 390, height: 844 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})
