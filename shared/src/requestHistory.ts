import { z } from 'zod'

export const naRequestStatusSchema = z.enum([
  'PROCESSING', 'NEEDS_INPUT', 'NO_MATCH', 'QUOTED', 'PENDING', 'CONFIRMED', 'FAILED', 'NOT_SUBMITTED',
])
export const naRequestSchema = z.object({
  id: z.uuid(),
  prompt: z.string().min(1).max(2000),
  status: naRequestStatusSchema,
  response: z.string().optional(),
  orderId: z.uuid().optional(),
  title: z.string().optional(),
  signature: z.string().optional(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
})
export type NaRequest = z.infer<typeof naRequestSchema>
