// The extension has no signer. All policy changes and transactions are reviewed in GoBuy.
export function walletReviewUrl(webOrigin: string, walletPresent = false) {
  const url = new URL('/na/mandate', webOrigin)
  if (!(url.protocol === 'https:' || url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) throw new Error('Invalid GoBuy origin')
  return { url: url.toString(), message: walletPresent ? 'Review and sign in GoBuy.' : 'Connect Phantom in the GoBuy web app. No wallet key is needed by Na Extension.' }
}
