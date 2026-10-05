/** An explicit numbered NFT purchase must never silently select a different numbered asset. */
export function namedNFTPurchaseName(text: string): string | undefined {
  return text.trim().match(/^(?:Na\s+)?(?:buy|purchase|mua)\s+(.+?\s*#\d+)(?=\s+(?:under|below|max|at most|dưới|duoi|tối đa)\b|[.!]?\s*$)/i)?.[1]?.trim()
}

// Only explicit collection wording or a compact named request; no guessed collection IDs.
export function namedNFTQuery(text: string): string | undefined {
  const value = text.trim().replace(/[.!?]+$/, '')
  const explicit = value.match(/(?:collections?|bộ sưu tập|bo suu tap)\s+(?:of\s+|của\s+|cua\s+)?(.+?)(?=\s+(?:under|below|dưới|duoi|max|worth|đáng|dang|rẻ|re|đắt|dat|hiếm|hiem|rarest?)\b|$)/i)?.[1]
  const compact = value.match(/^(?:find|search|show|buy|tìm|tim|mua|xem)\s+(?:this\s+)?([a-z0-9][a-z0-9_-]*)(?:\s+(?:worth buying|đáng mua|dang mua))?$/i)?.[1]
  const query = (explicit ?? compact)?.trim()
  return query && query.length <= 120 && !/^(nfts?|art|tranh|something|anything|any)$/i.test(query) ? query : undefined
}
