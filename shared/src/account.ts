import { z } from 'zod'
import { getCountries } from 'libphonenumber-js'

const text = (max: number) => z.string().trim().min(1).max(max).refine(value => !/[\u0000-\u001f]/.test(value), 'Invalid control characters')
export const shippingAddressSchema = z.object({
  recipient: text(100), country: z.string().refine(value => getCountries().includes(value as ReturnType<typeof getCountries>[number]), 'Chọn quốc gia hợp lệ'),
  line1: text(200), line2: z.string().trim().max(200).default(''),
  city: text(100), region: text(100).or(z.literal('')).default(''), postalCode: z.string().trim().max(20).default(''),
}).strict()
export type ShippingAddress = z.infer<typeof shippingAddressSchema>
export const accountProfileSchema = z.object({
  uid: z.string(), email: z.string().nullable(), phone: z.string().nullable(),
  address: shippingAddressSchema.nullable(), ready: z.boolean(),
})
export type AccountProfile = z.infer<typeof accountProfileSchema>
