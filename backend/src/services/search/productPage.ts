import { lookup } from 'node:dns/promises'
import { request } from 'node:https'
import { z } from 'zod'
import { candidateItemSchema, isPublicHttpsUrl, type CandidateItem } from '@gobuy/shared'
import { plainText, safeImage } from './http.js'
import { recordSourceEvidence } from '../verification/evidence.js'

export type PageReader = (url: string, signal: AbortSignal) => Promise<string | undefined>
export function isPublicIPv4(address: string): boolean {
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(address)) return false
  const [a, b, c, d] = address.split('.').map(Number)
  if ([a, b, c, d].some(value => value < 0 || value > 255)) return false
  return a > 0 && a < 224 && a !== 10 && a !== 127
    && !(a === 100 && b >= 64 && b <= 127) && !(a === 169 && b === 254)
    && !(a === 168 && b === 63 && c === 129 && d === 16)
    && !(a === 172 && b >= 16 && b <= 31) && !(a === 192 && (b === 0 || b === 168 || (b === 88 && c === 99)))
    && !(a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) && !(a === 203 && b === 0 && c === 113)
}

// DNS answers are checked and the TCP connection is pinned to an approved address.
// No redirects, cookies, credentials, scripts, subresources, or model-provided URLs.
export const fetchPublicHtml: PageReader = async (value, signal) => {
  if (!isPublicHttpsUrl(value)) throw new Error('Unsafe page URL')
  const url = new URL(value)
  signal.throwIfAborted()
  const addresses = await lookup(url.hostname, { all: true, family: 4 })
  signal.throwIfAborted()
  if (!addresses.length || addresses.some(entry => !isPublicIPv4(entry.address))) throw new Error('Non-public page address')
  return new Promise<string>((resolve, reject) => {
    const req = request(url, { signal, method: 'GET', agent: false, headers: { Accept: 'text/html', 'Accept-Encoding': 'identity', 'User-Agent': 'GoBuy-Na-Research/1.0' },
      lookup: (_hostname, options, callback) => {
        // Node can request all addresses for autoSelectFamily. Return only the pinned address.
        if (options.all) callback(null, [{ address: addresses[0].address, family: 4 }])
        else callback(null, addresses[0].address, 4)
      },
    }, response => {
      if (response.statusCode !== 200 || !response.headers['content-type']?.includes('text/html')
        || (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity')
        || Number(response.headers['content-length']) > 1_000_000) {
        response.destroy(); reject(new Error('Page unavailable or unsupported')); return
      }
      let size = 0
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > 1_000_000) { response.destroy(new Error('Page too large')); return }
        chunks.push(chunk)
      })
      response.on('error', reject)
      response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    })
    req.on('error', reject); req.end()
  })
}

const number = z.union([z.number(), z.string().regex(/^\d+(?:\.\d+)?$/).transform(Number)]).pipe(z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER))
const entity = z.union([z.string(), z.object({ name: z.string() })])
const offerSchema = z.object({
  '@type': z.literal('Offer'), price: number, priceCurrency: z.string().regex(/^[A-Z]{3}$/),
  url: z.string().optional(), availability: z.string().optional(), itemCondition: z.string().optional(),
  priceValidUntil: z.string().optional(), seller: entity.optional(),
  businessFunction: z.string().optional(),
})
const productSchema = z.object({
  '@type': z.union([z.literal('Product'), z.array(z.string()).refine(value => value.includes('Product'))]),
  name: z.string(), brand: entity.optional(), model: z.string().optional(), size: z.string().optional(),
  image: z.union([z.string(), z.array(z.string())]).optional(),
  offers: z.union([offerSchema, z.array(offerSchema).length(1)]),
  aggregateRating: z.object({ ratingValue: number, bestRating: number.optional(), worstRating: number.optional(), reviewCount: number.optional() }).optional(),
})
const entityName = (value?: z.infer<typeof entity>) => typeof value === 'string' ? value : value?.name
const schemaTerm = (value?: string) => value?.replace(/^https?:\/\/schema.org\//, '')

export function extractProductPage(lead: CandidateItem, html: string): CandidateItem | undefined {
  const nodes: unknown[] = []
  const collect = (value: unknown, depth = 0) => {
    if (depth > 4 || nodes.length >= 100) return
    if (Array.isArray(value)) { value.slice(0, 50).forEach(entry => collect(entry, depth + 1)); return }
    if (!value || typeof value !== 'object') return
    nodes.push(value)
    if ('@graph' in value) collect(value['@graph'], depth + 1)
  }
  const scripts = html.matchAll(/<script\b[^>]*\btype\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script\s*>/gi)
  for (const match of scripts) {
    try { collect(JSON.parse(match[1])) } catch { /* Invalid structured data is not evidence. */ }
    if (nodes.length >= 100) break
  }
  const products = nodes.filter(node => typeof node === 'object' && node !== null && '@type' in node
    && (node['@type'] === 'Product' || (Array.isArray(node['@type']) && node['@type'].includes('Product'))))
  // Category pages, multiple variants, and aggregate low/high prices are not single offers.
  if (products.length !== 1) return undefined
  const parsed = productSchema.safeParse(products[0])
  if (!parsed.success) return undefined
  const product = parsed.data, offer = Array.isArray(product.offers) ? product.offers[0] : product.offers
  if (offer.businessFunction && !['Sell', 'http://purl.org/goodrelations/v1#Sell', 'https://purl.org/goodrelations/v1#Sell'].includes(offer.businessFunction)) return undefined
  if (offer.url) {
    const offerUrl = new URL(offer.url, lead.productUrl), pageUrl = new URL(lead.productUrl)
    // Never attach a price for another page or a differently selected variant.
    if (offerUrl.origin !== pageUrl.origin || offerUrl.pathname !== pageUrl.pathname || offerUrl.search !== pageUrl.search) return undefined
  }
  if (offer.priceValidUntil && (!Number.isFinite(Date.parse(offer.priceValidUntil)) || Date.parse(offer.priceValidUntil.length === 10 ? offer.priceValidUntil + 'T23:59:59.999Z' : offer.priceValidUntil) < Date.now())) return undefined
  const availability = schemaTerm(offer.availability), condition = schemaTerm(offer.itemCondition)
  const rating = product.aggregateRating
  // A declared non-five-star scale is not silently normalized into a five-star claim.
  const productRating = rating && (rating.bestRating === undefined || rating.bestRating === 5)
    && (rating.worstRating === undefined || rating.worstRating <= 1) && rating.ratingValue <= 5 ? rating.ratingValue : undefined
  const organization = nodes.find(node => typeof node === 'object' && node !== null && '@type' in node && ['Organization', 'Store', 'OnlineStore'].includes(String(node['@type'])))
  const org = z.object({ name: z.string(), telephone: z.string().optional(), email: z.string().optional() }).safeParse(organization)
  const website = org.success ? { businessIdentity: plainText(org.data.name), contact: org.data.telephone || org.data.email ? plainText(org.data.telephone ?? org.data.email!) : undefined } : undefined
  const candidate = recordSourceEvidence({ ...lead, title: plainText(product.name), kind: 'product', fetchedAt: new Date().toISOString(),
    price: offer.price, currency: offer.priceCurrency, brand: entityName(product.brand) && plainText(entityName(product.brand)!),
    model: product.model && plainText(product.model), size: product.size && plainText(product.size),
    imageUrl: safeImage(Array.isArray(product.image) ? product.image[0] : product.image) ?? lead.imageUrl,
    seller: offer.seller ? { name: plainText(entityName(offer.seller)!) } : undefined,
    condition: condition === 'NewCondition' ? 'New' : condition === 'UsedCondition' ? 'Used' : condition === 'RefurbishedCondition' ? 'Refurbished' : undefined,
    stockStatus: availability === 'InStock' ? 'IN_STOCK' : availability === 'LimitedAvailability' ? 'LIMITED_STOCK'
      : availability === 'OutOfStock' || availability === 'SoldOut' || availability === 'Discontinued' ? 'OUT_OF_STOCK' : undefined,
    productRating, productReviewCount: rating?.reviewCount !== undefined && Number.isInteger(rating.reviewCount) ? rating.reviewCount : undefined,
    signals: { website },
  })
  for (const [field, value] of Object.entries(website ?? {})) if (value !== undefined) candidate.evidence!.push({ field: `website.${field}`, statement: value,
    reference: candidate.productUrl, retrievedAt: candidate.fetchedAt, kind: 'SOURCE_CLAIM' })
  const validated = candidateItemSchema.safeParse(candidate)
  return validated.success ? validated.data : undefined
}

export async function enrichProductPage(lead: CandidateItem, signal: AbortSignal, reader: PageReader): Promise<CandidateItem> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const page = await Promise.race([
      reader(lead.productUrl, AbortSignal.any([signal, controller.signal])),
      new Promise<undefined>(resolve => { timer = setTimeout(() => { controller.abort(); resolve(undefined) }, 2000) }),
    ])
    return page ? extractProductPage(lead, page) ?? lead : lead
  } catch { return lead }
  finally { clearTimeout(timer); controller.abort() }
}
