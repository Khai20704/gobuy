import type { PublicKey, Transaction } from '@solana/web3.js'
export type PhantomProvider = {
  isPhantom: boolean;
  publicKey: PublicKey | null;
  connect(): Promise<{ publicKey: PublicKey }>;
  disconnect(): Promise<void>;
  signTransaction(transaction: Transaction): Promise<Transaction>;
  signMessage?(message: Uint8Array, display?: 'utf8'): Promise<{ signature: Uint8Array } | Uint8Array>;
  on(event: 'accountChanged' | 'disconnect', callback: () => void): void;
  removeListener(event: 'accountChanged' | 'disconnect', callback: () => void): void;
}
declare global { interface Window { phantom?: { solana?: PhantomProvider }; solana?: PhantomProvider } }
export class PhantomUnavailableError extends Error {}
export class PhantomSignatureError extends Error {}
// Ed25519 signatures are always 64 bytes; anything else means the wallet did not sign this message.
export const ED25519_SIGNATURE_BYTES = 64
function phantomErrorCode(error: unknown) {
  return error && typeof error === 'object' && 'code' in error && typeof error.code === 'number' ? error.code : undefined
}
function signatureBytes(value: unknown): Uint8Array {
  const candidate = value && typeof value === 'object' && 'signature' in value ? value.signature : value
  if (candidate instanceof Uint8Array) return candidate
  if (Array.isArray(candidate) && candidate.every(byte => Number.isInteger(byte) && byte >= 0 && byte <= 255)) return Uint8Array.from(candidate)
  throw new PhantomSignatureError('Phantom không trả về chữ ký thông điệp hợp lệ; thử ký lại.')
}
// Phantom can surface a raw JSON-RPC error (including a bare "Unexpected error") that says nothing to
// the user. Translate the codes we know and never show the provider text verbatim.
export function describePhantomSignatureError(error: unknown): Error {
  const code = phantomErrorCode(error)
  if (code === 4001) return new Error('Bạn đã từ chối ký thông điệp trong Phantom. Bấm ký lại khi sẵn sàng.', { cause: error })
  if (code === -32603) return new Error('Phantom trả lỗi nội bộ khi ký thông điệp (mã -32603). Mở khóa Phantom rồi thử lại.', { cause: error })
  const detail = typeof code === 'number' ? ` (mã ${code})` : ''
  return new Error(`Phantom không ký được thông điệp${detail}. Thử lại sau khi kiểm tra Phantom.`, { cause: error })
}
async function requestSignature(provider: PhantomProvider, bytes: Uint8Array): Promise<Uint8Array> {
  if (!provider.signMessage) throw new PhantomSignatureError('Phantom bản này không hỗ trợ ký thông điệp (signMessage). Cập nhật extension Phantom rồi thử lại.')
  try { return signatureBytes(await provider.signMessage(bytes, 'utf8')) }
  catch (error) {
    // A malformed signature is not a transient provider failure; never re-sign the same payload for it.
    if (error instanceof PhantomSignatureError) throw error
    // Some Phantom builds reject the optional display argument with -32603; retry once without it so a
    // healthy wallet is never blocked by a cosmetic parameter.
    if (phantomErrorCode(error) !== -32603) throw describePhantomSignatureError(error)
    try { return signatureBytes(await provider.signMessage(bytes)) }
    catch (retryError) {
      throw retryError instanceof PhantomSignatureError ? retryError : describePhantomSignatureError(retryError)
    }
  }
}
// Signs an arbitrary UTF-8 message and returns the base64 signature the backend verifies.
export async function signPhantomMessage(provider: PhantomProvider, message: string): Promise<string> {
  const signature = await requestSignature(provider, new TextEncoder().encode(message))
  if (signature.length !== ED25519_SIGNATURE_BYTES) {
    throw new PhantomSignatureError(`Phantom trả về chữ ký ${signature.length} byte thay vì ${ED25519_SIGNATURE_BYTES} byte. Thông điệp chưa được xác minh; thử ký lại.`)
  }
  return btoa(String.fromCharCode(...signature))
}
export async function connectPhantom(provider: PhantomProvider) {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeoutError = new Error('Phantom chưa phản hồi sau 30 giây. Mở extension Phantom, mở khóa và xử lý yêu cầu kết nối đang chờ, rồi bấm kết nối lại.')
  try {
    return await Promise.race([
      provider.connect(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(timeoutError), 30000) }),
    ])
  }
  catch (error) {
    if (error === timeoutError) throw error
    const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
    if (code === 4001) throw new Error('Bạn đã từ chối kết nối Phantom. Bấm kết nối lại khi sẵn sàng.')
    if (code === -32002) throw new Error('Phantom đang có yêu cầu chờ. Mở extension và xử lý cửa sổ kết nối trước đó.')
    if (code === -32603) throw new Error('Phantom trả lỗi nội bộ khi kết nối (mã -32603). Trong Phantom, vào Settings → Connected Apps, ngắt kết nối với localhost nếu có, rồi tải lại trang và kết nối lại. Nếu vẫn lỗi, thoát hẳn Chrome rồi mở lại. Lỗi này chưa cho biết nguyên nhân cụ thể.', { cause: error })
    const detail = typeof code === 'number' ? ` (mã ${code})` : ''
    throw new Error(`Phantom không hoàn tất kết nối${detail}. Thử tải lại trang và kết nối lại.`, { cause: error })
  }
  finally { if (timer !== undefined) clearTimeout(timer) }
}
export function findPhantomProvider(): PhantomProvider | undefined {
  // Only accept a provider identifying itself as Phantom, even with other wallets installed.
  if (window.phantom?.solana?.isPhantom) return window.phantom.solana
  if (window.solana?.isPhantom) return window.solana
  return undefined
}
export async function phantomProvider(): Promise<PhantomProvider> {
  // Extensions can inject after React mounts. Recheck on each user-initiated connection.
  for (let attempt = 0; attempt < 8; attempt++) {
    const provider = findPhantomProvider()
    if (provider) return provider
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  throw new PhantomUnavailableError('Phantom was not detected in this browser tab. Check the extension in this Chrome profile, then reload the page. A wallet on your phone alone cannot connect through this button.')
}
