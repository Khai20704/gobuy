function publicHttps(value: string | undefined) {
  try {
    const url = new URL(value ?? '')
    const host = url.hostname.toLowerCase()
    return url.protocol === 'https:' && !url.username && !url.password
      && !/^(localhost|127\.|0\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[)/.test(host)
      && !host.endsWith('.localhost') && !host.endsWith('.local') && host.includes('.')
  } catch { return false }
}
export function publicMetadataUrl(id: string, image?: string, base = process.env.NFT_DEMO_PUBLIC_URL) {
  if (!publicHttps(base) || !publicHttps(image)) throw new Error('Public metadata URL and HTTPS image required; localhost metadata is not supported.')
  return `${base!.replace(/\/$/, '')}/api/acquisition/delivery-metadata/${id}`
}
export function demoImageUrl(base = process.env.NFT_DEMO_PUBLIC_URL) {
  if (!publicHttps(base)) throw new Error('Public metadata URL required for demo NFT.')
  return `${base!.replace(/\/$/, '')}/api/acquisition/demo-nft-image.svg`
}
export function validateCoreUrls(uri: string | undefined, image: string | undefined) {
  if (!publicHttps(uri) || !publicHttps(image)) throw new Error('Core requires durable public HTTPS metadata and image URLs.')
  for (const value of [uri!, image!]) {
    if (/(trycloudflare\.com|ngrok[^.]*\.(app|io)|loca\.lt)$/i.test(new URL(value).hostname)) throw new Error('Temporary tunnel metadata is not allowed for Core deliveries.')
  }
}
export const demoNftImage = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="800" viewBox="0 0 800 800"><rect width="800" height="800" fill="#eef5fd"/><rect x="80" y="80" width="640" height="640" rx="48" fill="#1e3a5f"/><circle cx="400" cy="300" r="110" fill="#6aa9ec"/><text x="400" y="490" text-anchor="middle" font-family="sans-serif" font-size="64" fill="white">GoBuy DEMO</text><text x="400" y="560" text-anchor="middle" font-family="sans-serif" font-size="30" fill="#cfe0f5">Simulated NFT · Solana Devnet</text><text x="400" y="620" text-anchor="middle" font-family="sans-serif" font-size="24" fill="#cfe0f5">Not an original marketplace NFT</text></svg>`

export async function verifyPublicMetadata(uri: string, expected: { name: string; image: string }, fetcher = fetch) {
  const response = await fetcher(uri, { signal: AbortSignal.timeout(10000), redirect: 'error' })
  if (!response.ok) throw new Error('Public metadata unavailable.')
  const value = await response.json() as { name?: string; symbol?: string; description?: string; image?: string; attributes?: { value?: string }[] }
  if (value.name !== expected.name || value.image !== expected.image || value.symbol !== 'DEMO-NFT' || !value.description
    || !value.attributes?.some(row => row.value === 'Demo / Simulated NFT')) throw new Error('Public metadata mismatch.')
  const image = await fetcher(expected.image, { signal: AbortSignal.timeout(10000), redirect: 'error' })
  if (!image.ok || !image.headers.get('content-type')?.startsWith('image/')) throw new Error('Public metadata image unavailable.')
  await image.body?.cancel()
}
