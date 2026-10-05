import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Link, Navigate } from 'react-router-dom'
import { createUserWithEmailAndPassword, GoogleAuthProvider, linkWithPhoneNumber, RecaptchaVerifier,
  sendPasswordResetEmail, signInWithEmailAndPassword, signInWithPopup, type ConfirmationResult } from 'firebase/auth'
import { getCountries, getCountryCallingCode, parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js'
import { shippingAddressSchema, type ShippingAddress } from '@gobuy/shared'
import { useAccount } from './AccountContext'
import { readAccountResponse } from './response'
import { accountAuth, accountFetch, authMessage, firebaseConfigured, phoneTestMode } from './firebase'
import './account.css'

const names = new Intl.DisplayNames(['vi'], { type: 'region' })
const countries = [...getCountries()].sort((a, b) => a === 'VN' ? -1 : b === 'VN' ? 1 : (names.of(a) ?? a).localeCompare(names.of(b) ?? b, 'vi'))
function CountryOptions({ phone = false }: { phone?: boolean }) { return <>{countries.map(code => <option key={code} value={code}>{names.of(code)}{phone ? ' (+' + getCountryCallingCode(code) + ')' : ''}</option>)}</> }

export function AccountPage({ edit = false }: { edit?: boolean }) {
  const account = useAccount()
  if (account.loading) return <main className="account-shell"><p role="status">Đang tải tài khoản…</p></main>
  if (account.error) return <main className="account-shell"><section className="account-card"><h1>Chưa tải được tài khoản</h1><p role="alert">{account.error}</p><button onClick={() => void account.refresh()}>Thử lại</button><button onClick={() => void account.logout()}>Đăng xuất</button></section></main>
  if (account.profile?.ready && !edit) return <Navigate to="/na" replace/>
  return <main className="account-shell"><aside className="account-story"><Link to="/na" className="account-brand">na<span>·</span></Link>
    <p className="account-eyebrow">NGƯỜI BẠN MUA SẮM</p><h1>Bắt đầu từ<br/>điều bạn thích.</h1><p>Một tài khoản để lưu thông tin nhận hàng và tiếp tục trò chuyện cùng Na.</p>
    <ol><li>Đăng nhập tài khoản</li><li>Xác minh số điện thoại</li><li>Thêm địa chỉ nhận hàng</li></ol><small>Ví Phantom chỉ dùng để ký giao dịch Devnet. Mật khẩu và địa chỉ không được đưa lên blockchain.</small></aside>
    <section className="account-card">
      {!account.user ? <LoginForm/> : <><div className="account-user"><span>{account.user.email}</span><button className="account-link" onClick={() => void account.logout()}>Đăng xuất</button></div>
        {!account.profile?.phone ? <PhoneForm/> : <AddressForm key={account.user.uid} edit={edit}/>}</>}
    </section></main>
}

function LoginForm() {
  const [mode, setMode] = useState<'login' | 'register' | 'reset'>('login')
  const [email, setEmail] = useState(''), [password, setPassword] = useState(''), [repeat, setRepeat] = useState('')
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('')
  async function run(action: () => Promise<unknown>) {
    if (busy || !accountAuth) return
    setBusy(true); setError(''); setNotice('')
    try { await action() } catch (error) { setError(authMessage(error)) } finally { setBusy(false) }
  }
  function submit(event: FormEvent) {
    event.preventDefault()
    if (mode === 'register' && password !== repeat) { setError('Hai mật khẩu chưa khớp.'); return }
    void run(async () => {
      if (mode === 'reset') { await sendPasswordResetEmail(accountAuth!, email.trim()); setNotice('Nếu email có tài khoản, bạn sẽ nhận được hướng dẫn đặt lại mật khẩu.'); return }
      await (mode === 'register' ? createUserWithEmailAndPassword : signInWithEmailAndPassword)(accountAuth!, email.trim(), password)
    })
  }
  return <><p className="account-eyebrow">BƯỚC 1 / 3</p><h2>{mode === 'register' ? 'Tạo tài khoản Na' : mode === 'reset' ? 'Quên mật khẩu?' : 'Chào bạn trở lại'}</h2><p>Đăng nhập bằng Google hoặc email của bạn.</p>
    {!firebaseConfigured && <p role="alert" className="account-notice">Chưa cấu hình dịch vụ đăng nhập. Quản trị viên cần thiết lập Firebase trước khi đăng nhập và gửi SMS.</p>}
    <button className="google-button" disabled={busy || !firebaseConfigured} onClick={() => void run(() => signInWithPopup(accountAuth!, new GoogleAuthProvider()))}>
      <svg className="google-button-icon" width="20" height="20" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path fill="#4285F4" d="M21.6 12.23c0-.71-.06-1.39-.18-2.05H12v3.88h5.38a4.6 4.6 0 0 1-2 3.02v2.51h3.24c1.9-1.75 2.98-4.33 2.98-7.36Z"/>
        <path fill="#34A853" d="M12 22c2.7 0 4.96-.9 6.62-2.41l-3.24-2.51c-.9.6-2.05.96-3.38.96-2.6 0-4.81-1.76-5.6-4.12H3.06v2.59A10 10 0 0 0 12 22Z"/>
        <path fill="#FBBC05" d="M6.4 13.92a6 6 0 0 1 0-3.84V7.49H3.06a10 10 0 0 0 0 9.02l3.34-2.59Z"/>
        <path fill="#EA4335" d="M12 5.96c1.47 0 2.79.51 3.82 1.51l2.87-2.87A9.6 9.6 0 0 0 12 2a10 10 0 0 0-8.94 5.49l3.34 2.59C7.19 7.72 9.4 5.96 12 5.96Z"/>
      </svg>
      <span>Tiếp tục với Google</span>
    </button>
    <div className="account-divider">hoặc dùng email</div>
    <form onSubmit={submit}><label>Email<input type="email" autoComplete="email" required maxLength={254} value={email} onChange={e => setEmail(e.target.value)} disabled={busy}/></label>
      {mode !== 'reset' && <label>Mật khẩu<input type="password" autoComplete={mode === 'register' ? 'new-password' : 'current-password'} minLength={mode === 'register' ? 10 : undefined} maxLength={128} required value={password} onChange={e => setPassword(e.target.value)} disabled={busy}/></label>}
      {mode === 'register' && <><small>Dùng ít nhất 10 ký tự cho mật khẩu.</small><label>Nhập lại mật khẩu<input type="password" autoComplete="new-password" required value={repeat} onChange={e => setRepeat(e.target.value)} disabled={busy}/></label></>}
      {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
      <button className="account-primary" disabled={busy || !firebaseConfigured}>{busy ? 'Đang xử lý…' : mode === 'register' ? 'Tạo tài khoản' : mode === 'reset' ? 'Gửi email đặt lại' : 'Đăng nhập'}</button>
    </form><div className="account-actions"><button disabled={busy} onClick={() => { setMode(mode === 'register' ? 'login' : 'register'); setError(''); setNotice('') }}>{mode === 'register' ? 'Đã có tài khoản? Đăng nhập' : 'Chưa có tài khoản? Đăng ký'}</button><button disabled={busy} onClick={() => { setMode(mode === 'reset' ? 'login' : 'reset'); setError(''); setNotice('') }}>{mode === 'reset' ? 'Quay lại đăng nhập' : 'Quên mật khẩu'}</button></div></>
}

function PhoneForm() {
  const account = useAccount()
  const [country, setCountry] = useState<CountryCode>('VN'), [phone, setPhone] = useState(''), [code, setCode] = useState('')
  const [consent, setConsent] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const [confirmation, setConfirmation] = useState<ConfirmationResult | null>(null), [sentTo, setSentTo] = useState('')
  const [cooldown, setCooldown] = useState(0)
  const container = useRef<HTMLDivElement>(null), verifier = useRef<RecaptchaVerifier | null>(null)
  useEffect(() => () => verifier.current?.clear(), [])
  useEffect(() => { if (!cooldown) return; const timer = setTimeout(() => setCooldown(cooldown - 1), 1000); return () => clearTimeout(timer) }, [cooldown])
  async function send() {
    if (!accountAuth?.currentUser || busy || cooldown || !consent) return
    const parsed = parsePhoneNumberFromString(phone, country)
    if (!parsed?.isValid() || parsed.country !== country) { setError('Nhập số điện thoại hợp lệ cho quốc gia đã chọn.'); return }
    setBusy(true); setError(''); setConfirmation(null); setCode('')
    try {
      verifier.current?.clear()
      verifier.current = new RecaptchaVerifier(accountAuth, container.current!, { size: 'normal' })
      const next = await linkWithPhoneNumber(accountAuth.currentUser, parsed.number, verifier.current)
      setConfirmation(next); setSentTo(parsed.number); setCooldown(60)
    } catch (error) { setError(authMessage(error)); setCooldown(30); verifier.current?.clear(); verifier.current = null }
    finally { setBusy(false) }
  }
  async function confirm(event: FormEvent) {
    event.preventDefault()
    if (!confirmation || busy) return
    setBusy(true); setError('')
    try { const result = await confirmation.confirm(code); await result.user.getIdToken(true); await account.refresh() }
    catch (error) { setError(authMessage(error)) } finally { setBusy(false) }
  }
  return <><p className="account-eyebrow">BƯỚC 2 / 3</p><h2>Xác minh điện thoại</h2><p>Số đã xác minh sẽ dùng để liên hệ giao hàng.</p>
    <label>Quốc gia của số điện thoại<select value={country} disabled={busy || !!confirmation} onChange={e => setCountry(e.target.value as CountryCode)}><CountryOptions phone/></select></label>
    <label>Số điện thoại<input type="tel" autoComplete="tel-national" placeholder="0912 345 678" maxLength={25} value={phone} disabled={busy || !!confirmation} onChange={e => setPhone(e.target.value)}/></label>
    <label className="account-consent"><input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} disabled={busy}/> Tôi đồng ý nhận SMS xác minh. Google xử lý số điện thoại để xác thực và chống lạm dụng.</label>
    {phoneTestMode && <p role="status">Đang thử nghiệm: chỉ dùng số đã lưu trong Firebase Phone numbers for testing và mã OTP đã đặt. Không gửi SMS thật.</p>}
    <div ref={container}/>
    {error && <p role="alert">{error}</p>}
    <button disabled={busy || !!cooldown || !consent} onClick={() => void send()}>{cooldown ? `Gửi lại sau ${cooldown}s` : confirmation ? 'Gửi lại OTP' : 'Gửi mã OTP'}</button>
    {confirmation && <form onSubmit={confirm}><p role="status">Mã đã được gửi tới {sentTo}.</p><label>Mã OTP<input inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required value={code} disabled={busy} onChange={e => setCode(e.target.value.replace(/\D/g, ''))}/></label><button className="account-primary" disabled={busy || code.length !== 6}>Xác minh số điện thoại</button><button type="button" disabled={busy} onClick={() => { setConfirmation(null); setCode(''); setError('') }}>Đổi số điện thoại</button></form>}
    <small>SMS có thể bị giới hạn theo quốc gia hoặc nhà mạng. Không chia sẻ mã OTP với người khác.</small></>
}

function AddressForm({ edit }: { edit: boolean }) {
  const account = useAccount()
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const address = account.profile?.address
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (busy) return
    const data = Object.fromEntries(new FormData(event.currentTarget))
    const input = shippingAddressSchema.safeParse(data)
    if (!input.success) { setError('Điền đầy đủ thông tin người nhận và địa chỉ.'); return }
    setBusy(true); setError('')
    try {
      const response = await accountFetch('/api/account/address', { method: 'PUT', body: JSON.stringify(input.data) })
      await readAccountResponse(response)
      await account.refresh()
    } catch (error) { setError(authMessage(error)) } finally { setBusy(false) }
  }
  const field = (name: keyof ShippingAddress, label: string, autoComplete: string, required = true) => <label>{label}<input name={name} defaultValue={address?.[name] ?? ''} autoComplete={autoComplete} required={required} maxLength={name === 'postalCode' ? 20 : 200} disabled={busy}/></label>
  return <><p className="account-eyebrow">{edit ? 'HỒ SƠ NHẬN HÀNG' : 'BƯỚC 3 / 3'}</p><h2>Giao đến địa chỉ của bạn</h2><p>Điện thoại đã xác minh: <strong>{account.profile?.phone}</strong></p><form onSubmit={save}>
    {field('recipient', 'Tên người nhận', 'name')}<label>Quốc gia giao hàng<select name="country" defaultValue={address?.country ?? 'VN'} disabled={busy}><CountryOptions/></select></label>
    {field('line1', 'Số nhà, tên đường', 'address-line1')}{field('line2', 'Căn hộ, phường/xã (nếu có)', 'address-line2', false)}
    {field('city', 'Thành phố / địa phương', 'address-level2')}
    {field('postalCode', 'Mã bưu chính (nếu có)', 'postal-code', false)}
    <p className="account-note">Địa chỉ được lưu để dùng cho đơn hàng vật lý sau này. NFT Devnet được gửi vào ví, không giao tới địa chỉ này.</p>
    {error && <p role="alert">{error}</p>}<button className="account-primary" disabled={busy}>{busy ? 'Đang lưu…' : 'Lưu địa chỉ'}</button>
  </form>{edit && <Link className="account-return" to="/na">Quay lại trò chuyện với Na →</Link>}</>
}
