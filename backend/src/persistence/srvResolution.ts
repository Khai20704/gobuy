const DEFAULT_DOH_ENDPOINTS = ['https://cloudflare-dns.com/dns-query', 'https://dns.google/resolve'] as const
const DEFAULT_TIMEOUT_MS = 8000
const SRV_RECORD_PREFIX = '_mongodb._tcp.'
const DNS_TYPE_SRV = 33
const DNS_TYPE_TXT = 16

export interface SrvEndpoint {
  host: string
  port: number
}

export interface DohResolutionOptions {
  endpoints?: readonly string[]
  timeoutMs?: number
  fetchImpl?: typeof fetch
}

export interface DohAnswer {
  type?: number
  data?: string
}

export interface DohResponse {
  Status?: number
  Answer?: DohAnswer[]
}

/**
 * A `mongodb+srv://` URI requires an SRV DNS lookup before the driver can reach any host.
 * Some networks (notably ISP resolvers that intercept port 53) answer SRV queries with a
 * malformed packet, which c-ares reports as EBADRESP, so the driver never contacts Atlas.
 */
export function isSrvUri(uri: string): boolean {
  return uri.trim().toLowerCase().startsWith('mongodb+srv://')
}

interface ParsedConnectionString {
  credentials: string
  hosts: string
  path: string
  query: string
}

/** Splits a connection string manually: the URL API rejects multi-host seed lists. */
function splitConnectionString(uri: string): ParsedConnectionString {
  const trimmed = uri.trim()
  const schemeEnd = trimmed.indexOf('://')
  if (schemeEnd < 0) throw new Error('Connection string must start with mongodb:// or mongodb+srv://')
  const rest = trimmed.slice(schemeEnd + 3)
  const pathStart = rest.indexOf('/')
  const authority = pathStart < 0 ? rest : rest.slice(0, pathStart)
  const pathAndQuery = pathStart < 0 ? '' : rest.slice(pathStart)
  const queryStart = pathAndQuery.indexOf('?')
  const at = authority.lastIndexOf('@')
  return {
    credentials: at < 0 ? '' : authority.slice(0, at),
    hosts: at < 0 ? authority : authority.slice(at + 1),
    path: queryStart < 0 ? pathAndQuery : pathAndQuery.slice(0, queryStart),
    query: queryStart < 0 ? '' : pathAndQuery.slice(queryStart + 1),
  }
}

export function srvLookupName(uri: string): string {
  return `${SRV_RECORD_PREFIX}${splitConnectionString(uri).hosts.split(':')[0]}`
}

export function parseSrvAnswers(answers: readonly DohAnswer[]): SrvEndpoint[] {
  return answers
    .filter(answer => answer.type === DNS_TYPE_SRV && typeof answer.data === 'string')
    .map(answer => (answer.data as string).trim().split(/\s+/))
    .filter(parts => parts.length >= 4)
    .map(parts => ({ host: parts[3]!.replace(/\.$/, ''), port: Number(parts[2]) }))
    .filter(record => record.host.length > 0 && Number.isInteger(record.port) && record.port > 0)
}

export function parseTxtAnswers(answers: readonly DohAnswer[]): string[] {
  return answers
    .filter(answer => answer.type === DNS_TYPE_TXT && typeof answer.data === 'string')
    .map(answer => (answer.data as string).trim().replace(/^"+|"+$/g, ''))
    .filter(value => value.length > 0)
}

/** Rebuilds the SRV URI as an equivalent direct `mongodb://` seed list. Credentials stay percent-encoded. */
export function buildDirectUri(srvUri: string, records: readonly SrvEndpoint[], txtOptions: readonly string[] = []): string {
  if (!records.length) throw new Error('At least one SRV endpoint is required')
  // Credentials are copied verbatim so they stay percent-encoded exactly as configured.
  const { credentials, path, query } = splitConnectionString(srvUri)
  const hosts = records.map(record => `${record.host}:${record.port}`).join(',')
  const params = new URLSearchParams(query)
  // The SRV host TXT record carries authSource and replicaSet; explicit URI options always win.
  for (const option of txtOptions) {
    for (const [key, value] of new URLSearchParams(option)) if (!params.has(key)) params.set(key, value)
  }
  // mongodb+srv:// implies TLS; a plain mongodb:// seed list does not.
  if (!params.has('tls') && !params.has('ssl')) params.set('tls', 'true')
  return `mongodb://${credentials ? `${credentials}@` : ''}${hosts}${path || '/'}?${params.toString()}`
}

async function queryDoh(endpoint: string, name: string, type: 'SRV' | 'TXT',
  fetchImpl: typeof fetch, timeoutMs: number): Promise<DohAnswer[]> {
  const separator = endpoint.includes('?') ? '&' : '?'
  const url = `${endpoint}${separator}name=${encodeURIComponent(name)}&type=${type}`
  const response = await fetchImpl(url, { headers: { accept: 'application/dns-json' }, signal: AbortSignal.timeout(timeoutMs) })
  if (!response.ok) throw new Error(`responded with status ${response.status}`)
  const body = await response.json() as DohResponse
  if (typeof body.Status === 'number' && body.Status !== 0) throw new Error(`returned DNS status ${body.Status}`)
  return body.Answer ?? []
}

/**
 * Resolves a `mongodb+srv://` URI into a direct seed list without using the system resolver.
 * Throws only when every configured DNS-over-HTTPS endpoint fails; the message never contains credentials.
 */
export async function resolveDirectUri(srvUri: string, options: DohResolutionOptions = {}): Promise<string> {
  const endpoints = options.endpoints?.length ? options.endpoints : DEFAULT_DOH_ENDPOINTS
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const fetchImpl = options.fetchImpl ?? fetch
  const lookupName = srvLookupName(srvUri)
  const failures: string[] = []
  for (const endpoint of endpoints) {
    try {
      const records = parseSrvAnswers(await queryDoh(endpoint, lookupName, 'SRV', fetchImpl, timeoutMs))
      if (!records.length) {
        failures.push(`${endpoint} returned no SRV records`)
        continue
      }
      let txtOptions: string[] = []
      try {
        txtOptions = parseTxtAnswers(await queryDoh(endpoint, lookupName.slice(SRV_RECORD_PREFIX.length), 'TXT', fetchImpl, timeoutMs))
      } catch {
        txtOptions = []
      }
      return buildDirectUri(srvUri, records, txtOptions)
    } catch (error) {
      failures.push(`${endpoint} ${error instanceof Error ? error.message.slice(0, 120) : 'request failed'}`)
    }
  }
  throw new Error(`SRV lookup over DNS-over-HTTPS failed for ${lookupName}: ${failures.join('; ')}`)
}
