// Injected only on an explicit user action. Keep self-contained for executeScript.
// No forms, body text, cookies, storage, wallet APIs, or message listeners are read.
export function extractPageContext() {
  const title = document.querySelector('meta[property="og:title"]')?.getAttribute('content') ?? document.title
  const price = document.querySelector('meta[property="product:price:amount"]')?.getAttribute('content')
  const currency = document.querySelector('meta[property="product:price:currency"]')?.getAttribute('content')
  const url = new URL(location.href)
  url.search = ''; url.hash = ''
  const collection = url.hostname.endsWith('magiceden.io') ? url.pathname.match(/^\/marketplace\/([a-zA-Z0-9_-]{1,80})\/?$/)?.[1] : undefined
  return { classification: 'UNTRUSTED_EXTERNAL_CONTENT' as const, url: url.toString(), title: title.slice(0, 300),
    ...(price ? { priceText: `${price} ${currency ?? ''}`.slice(0, 80) } : {}), ...(collection ? { collectionSymbol: collection } : {}) }
}
