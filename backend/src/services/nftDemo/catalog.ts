import { isNftDemoPurchaseRequest, normalizeNftRequest } from '@gobuy/shared'

export const demoArt = [
  { id: 'quiet-orbit', name: 'Quiet Orbit', priceLamports: 100_000_000, colors: ['#e8e4d5', '#64806d', '#d9a571'], tags: ['abstract', 'truu tuong', 'orbit'] },
  { id: 'blue-tide', name: 'Blue Tide', priceLamports: 200_000_000, colors: ['#dbe8e7', '#326575', '#95c8be'], tags: ['ocean', 'sea', 'bien', 'blue'] },
  { id: 'evening-light', name: 'Evening Light', priceLamports: 350_000_000, colors: ['#f5e3d4', '#a46754', '#e9b96e'], tags: ['sunset', 'hoang hon', 'evening'] },
  { id: 'forest-canopy', name: 'Forest Canopy', priceLamports: 250_000_000, colors: ['#dce5d2', '#365842', '#a8bb7b'], tags: ['forest', 'rung', 'trees', 'woodland'] },
] as const
export type DemoArt = typeof demoArt[number]
export const normalizeText = normalizeNftRequest

export function parseDemoBuy(text: string): { maximumLamports: number; topic?: string } | { message: string } {
  const value = normalizeText(text.trim())
  if (!isNftDemoPurchaseRequest(value)) {
    return { message: 'Bạn muốn mua tranh NFT demo? Hãy nói: “Mua 1 tranh NFT dưới 1 SOL”. Na chỉ mua khi bạn yêu cầu mua rõ ràng.' }
  }
  if (!/\bnft\b/.test(value)) return { message: 'Bản demo này chỉ mua tranh NFT trên Solana devnet. Hãy thử “Mua tranh NFT dưới 1 SOL”.' }
  if (/\b(?:mua|buy|purchase)\s+([2-9]|\d{2,})\b/.test(value) || /\b(?:mainnet|testnet|collection)\b/.test(value)) {
    return { message: 'Demo hiện mua 1 tranh mỗi lần từ Na Demo Gallery trên devnet; chưa hỗ trợ collection bên ngoài hoặc mạng khác.' }
  }
  const amounts = [...value.matchAll(/(?:duoi|under|below|toi da|maximum|max|budget|up to)\s*(\d+(?:[.,]\d{1,9})?)\s*sol\b/g)]
  if (amounts.length !== 1) return { message: 'Hãy nêu một ngân sách SOL rõ ràng, ví dụ “Mua tranh NFT dưới 1 SOL”. Ngân sách bao gồm giá tranh và phí.' }
  const decimal = amounts[0][1].replace(',', '.')
  const [whole, fraction = ''] = decimal.split('.')
  const units = BigInt(whole) * 1_000_000_000n + BigInt(fraction.padEnd(9, '0'))
  // "under" is strict. No float rounding may add spending authority.
  const maximum = units - (/^(duoi|under|below)/.test(amounts[0][0]) ? 1n : 0n)
  if (maximum <= 0 || maximum > 10_000_000_000n) return { message: 'Ngân sách demo phải lớn hơn 0 và không quá 10 SOL.' }
  // Unknown explicit subjects must not silently become an unrelated abstract print.
  const topic = value.match(/\b(?:nft|tranh)\s+(?:ve\s+|of\s+)(.+?)(?=\s+(?:duoi|under|below|toi da|max|budget)|$)/)?.[1].trim()
  return { maximumLamports: Number(maximum), topic }
}

export function selectDemoArt(maximum: number, topic?: string): DemoArt | undefined {
  return demoArt.find(art => art.priceLamports < maximum && (!topic || art.tags.some(tag => topic.includes(tag)) || normalizeText(art.name) === topic))
}

export function artSvg(art: DemoArt): string {
  const [background, foreground, accent] = art.colors
  return `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="800" viewBox="0 0 800 800"><rect width="800" height="800" fill="${background}"/><circle cx="400" cy="350" r="210" fill="${foreground}"/><ellipse cx="400" cy="400" rx="310" ry="95" fill="none" stroke="${accent}" stroke-width="32" transform="rotate(-25 400 400)"/><text x="60" y="710" font-family="sans-serif" font-size="32" fill="${foreground}">${art.name}</text><text x="60" y="750" font-family="sans-serif" font-size="16" fill="${foreground}">NA DEMO GALLERY · DEVNET</text></svg>`
}
