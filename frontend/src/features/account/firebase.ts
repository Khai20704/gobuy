import { initializeApp } from 'firebase/app'
import { connectAuthEmulator, getAuth } from 'firebase/auth'

const env = import.meta.env
export const phoneTestMode = env.DEV && ['localhost', '127.0.0.1'].includes(window.location.hostname) && env.VITE_FIREBASE_PHONE_TEST_MODE === 'true'
export const firebaseConfigured = !!(env.VITE_FIREBASE_API_KEY && env.VITE_FIREBASE_AUTH_DOMAIN && env.VITE_FIREBASE_PROJECT_ID && env.VITE_FIREBASE_APP_ID)
export const accountAuth = firebaseConfigured ? getAuth(initializeApp({
  apiKey: env.VITE_FIREBASE_API_KEY, authDomain: env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: env.VITE_FIREBASE_PROJECT_ID, appId: env.VITE_FIREBASE_APP_ID,
}, 'na-account')) : null
if (accountAuth && phoneTestMode) accountAuth.settings.appVerificationDisabledForTesting = true
if (accountAuth && env.VITE_FIREBASE_AUTH_EMULATOR_URL) {
  const url = new URL(env.VITE_FIREBASE_AUTH_EMULATOR_URL)
  if (!env.DEV || !['localhost', '127.0.0.1'].includes(url.hostname) || !env.VITE_FIREBASE_PROJECT_ID.startsWith('demo-')) throw new Error('Auth emulator is restricted to local development with a demo project.')
  connectAuthEmulator(accountAuth, url.origin)
}

export async function accountFetch(path: string, init: RequestInit = {}) {
  const user = accountAuth?.currentUser
  if (!user) throw new Error('Đăng nhập để tiếp tục.')
  const headers = new Headers(init.headers)
  headers.set('Authorization', 'Bearer ' + await user.getIdToken())
  headers.set('Content-Type', 'application/json')
  return fetch(path, { ...init, headers, signal: init.signal ?? AbortSignal.timeout(15000) })
}
export function authMessage(error: unknown): string {
  const code = (error as { code?: string })?.code
  const messages: Record<string, string> = {
    'auth/invalid-credential': 'Email hoặc mật khẩu không đúng.',
    'auth/email-already-in-use': 'Email đã có tài khoản. Hãy đăng nhập hoặc đặt lại mật khẩu.',
    'auth/weak-password': 'Mật khẩu chưa đủ mạnh.',
    'auth/invalid-email': 'Email không hợp lệ.',
    'auth/popup-closed-by-user': 'Bạn đã đóng cửa sổ Google. Có thể thử lại.',
    'auth/popup-blocked': 'Trình duyệt chặn cửa sổ Google. Cho phép popup rồi thử lại.',
    'auth/account-exists-with-different-credential': 'Email này đã dùng phương thức đăng nhập khác. Hãy dùng phương thức ban đầu.',
    'auth/credential-already-in-use': 'Số điện thoại đã được liên kết với tài khoản khác.',
    'auth/invalid-verification-code': 'Mã OTP không đúng. Kiểm tra SMS rồi nhập lại.',
    'auth/code-expired': 'Mã OTP đã hết hạn. Hãy gửi mã mới.',
    'auth/session-expired': 'Phiên OTP đã hết hạn. Hãy gửi mã mới.',
    'auth/too-many-requests': 'Quá nhiều lần thử. Vui lòng đợi rồi thử lại.',
    'auth/quota-exceeded': 'Dịch vụ SMS đã hết hạn mức. Vui lòng thử lại sau.',
    'auth/captcha-check-failed': 'Chưa xác minh được reCAPTCHA. Hãy thử lại.',
    'auth/requires-recent-login': 'Hãy đăng xuất và đăng nhập lại trước khi xác minh số.',
    'auth/operation-not-allowed': 'Firebase từ chối xác minh điện thoại. Kiểm tra Phone và SMS region policy của dự án (auth/operation-not-allowed).',
    'auth/billing-not-enabled': 'Dự án chưa bật thanh toán để gửi SMS thật. Khi thử nghiệm, dùng số đã lưu trong Phone numbers for testing.',
    'auth/unauthorized-domain': 'Tên miền này chưa được phép đăng nhập trong Firebase.',
    'auth/network-request-failed': 'Không kết nối được dịch vụ đăng nhập. Kiểm tra mạng rồi thử lại.',
  }
  return code ? messages[code] ?? 'Dịch vụ đăng nhập chưa sẵn sàng. Kiểm tra cấu hình Firebase hoặc thử lại sau.'
    : error instanceof Error ? error.message : 'Không hoàn tất được yêu cầu. Vui lòng thử lại.'
}
