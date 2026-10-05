import { MongoProfileStore } from '../persistence/MongoProfileStore.js'
import { storageMode } from '../persistence/mongo.js'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { Router, type RequestHandler } from 'express'
import { getApps, initializeApp } from 'firebase-admin/app'
import { firebaseCredential } from './firebaseCredential.js'
import { getAuth } from 'firebase-admin/auth'
import { shippingAddressSchema, type ShippingAddress, type AccountProfile } from '@gobuy/shared'

export type Identity = { uid: string; email: string | null; phone: string | null }
export interface IdentityVerifier { verify(token: string): Promise<Identity> }
export interface ProfileStore { syncIdentity?(identity: Identity): Promise<void>; read(uid: string): Promise<ShippingAddress | null>; save(uid: string, address: ShippingAddress): Promise<void> }

export class FileProfileStore implements ProfileStore {
  constructor(private readonly directory = resolve(process.env.ACCOUNT_DATA_DIR || '.data/accounts')) {}
  private path(uid: string) { return join(this.directory, createHash('sha256').update(uid).digest('hex') + '.json') }
  async read(uid: string) {
    try { return shippingAddressSchema.parse(JSON.parse(await readFile(this.path(uid), 'utf8'))) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
  }
  async save(uid: string, address: ShippingAddress) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    const target = this.path(uid), temporary = target + '.' + randomUUID() + '.tmp'
    await writeFile(temporary, JSON.stringify(shippingAddressSchema.parse(address)), { mode: 0o600 })
    await rename(temporary, target)
  }
}

export class FirebaseIdentityVerifier implements IdentityVerifier {
  async verify(token: string): Promise<Identity> {
    const projectId = process.env.FIREBASE_PROJECT_ID
    if (!projectId) throw new Error('AUTH_NOT_CONFIGURED')
    const emulator = process.env.FIREBASE_AUTH_EMULATOR_HOST
    if (emulator && (process.env.NODE_ENV === 'production' || !/^(localhost|127\.0\.0\.1):\d+$/.test(emulator) || !projectId.startsWith('demo-'))) throw new Error('Unsafe emulator configuration')
    const app = getApps().find(item => item.name === 'na-accounts') ?? initializeApp({ projectId,
      ...(emulator ? {} : { credential: firebaseCredential() }),
    }, 'na-accounts')
    const auth = getAuth(app)
    const decoded = await auth.verifyIdToken(token, true)
    const user = await auth.getUser(decoded.uid)
    if (user.disabled || !user.providerData.some(provider => ['password', 'google.com'].includes(provider.providerId))) throw new Error('Invalid account')
    return { uid: user.uid, email: user.email ?? null, phone: user.phoneNumber ?? null }
  }
}

export function createAccounts(verifier: IdentityVerifier = new FirebaseIdentityVerifier(), store: ProfileStore = storageMode() === 'mongo' ? new MongoProfileStore() : new FileProfileStore()) {
  const authenticate: RequestHandler = async (req, res, next) => {
    const token = req.get('authorization')?.match(/^Bearer (\S+)$/)?.[1]
    if (!token) { res.status(401).json({ error: { message: 'Đăng nhập để tiếp tục.' } }); return }
    try { res.locals.identity = await verifier.verify(token) }
    catch (error) {
      const missing = error instanceof Error && error.message === 'AUTH_NOT_CONFIGURED'
      res.status(missing ? 503 : 401).json({ error: { message: missing ? 'Chưa cấu hình Firebase cho backend.' : 'Phiên đăng nhập không hợp lệ. Vui lòng đăng nhập lại.' } }); return
    }
    next()
  }
  const profile = async (identity: Identity): Promise<AccountProfile> => {
    await store.syncIdentity?.(identity)
    const address = await store.read(identity.uid)
    return { ...identity, address, ready: !!identity.phone && !!address }
  }
  const requireReady: RequestHandler = async (req, res, next) => {
    await authenticate(req, res, async error => {
      if (error) { next(error); return }
      try {
        const value = await profile(res.locals.identity)
        if (!value.ready) { res.status(403).json({ error: { message: 'Xác minh điện thoại và lưu địa chỉ giao hàng trước khi mua.' } }); return }
        next()
      } catch (error) { next(error) }
    })
  }
  const router = Router()
  router.use(authenticate)
  router.get('/me', async (_req, res) => res.json(await profile(res.locals.identity)))
  router.put('/address', async (req, res) => {
    const identity = res.locals.identity as Identity
    if (!identity.phone) { res.status(403).json({ error: { message: 'Xác minh số điện thoại trước khi lưu địa chỉ.' } }); return }
    const input = shippingAddressSchema.safeParse(req.body)
    if (!input.success) { res.status(400).json({ error: { message: 'Kiểm tra tên người nhận, quốc gia, tỉnh/thành phố và địa chỉ.' } }); return }
    await store.save(identity.uid, input.data)
    res.json(await profile(identity))
  })
  return { router, requireReady, requireAuthenticated: authenticate }
}
