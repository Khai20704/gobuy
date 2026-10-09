/** Exact decimal arithmetic; never round a delivery above the paid reference quantity. */
export function decimalRatio(value: string): [bigint, bigint] {
  if (!/^\d+(\.\d+)?([eE][+-]?\d+)?$/.test(value) || value.length > 100) throw new Error('Invalid reference price/amount.')
  const [coefficient, exponent = '0'] = value.toLowerCase().split('e')
  const [whole, fraction = ''] = coefficient.split('.')
  const scale = fraction.length - Number(exponent)
  if (Math.abs(scale) > 30) throw new Error('Reference precision out of range.')
  return scale >= 0 ? [BigInt(whole + fraction), 10n ** BigInt(scale)]
    : [BigInt(whole + fraction) * 10n ** BigInt(-scale), 1n]
}
export function deliveryUnits(amount: string, price: string, decimals = 6): string {
  const [a, ad] = decimalRatio(amount), [p, pd] = decimalRatio(price)
  if (a <= 0n || p <= 0n || !Number.isInteger(decimals) || decimals < 0 || decimals > 9) throw new Error('Positive validated amount and price required.')
  const units = a * pd * 10n ** BigInt(decimals) / (ad * p)
  if (units <= 0n || units > 18446744073709551615n) throw new Error('Delivery quantity outside token limits.')
  return units.toString()
}
export function decimalUnits(raw: string, decimals: number): string {
  const value = BigInt(raw), base = 10n ** BigInt(decimals)
  const fraction = (value % base).toString().padStart(decimals, '0').replace(/0+$/, '')
  return `${value / base}${fraction ? '.' + fraction : ''}`
}
