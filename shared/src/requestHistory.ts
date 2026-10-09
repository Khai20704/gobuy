import { z } from 'zod'
import { purchasePhaseSchema } from './devnetDelivery.js'

export const naRequestStatusSchema = z.enum([
  'PROCESSING', 'NEEDS_INPUT', 'NO_MATCH', 'QUOTED', 'PENDING', 'CONFIRMED', 'FAILED', 'NOT_SUBMITTED',
])
export const naRequestSchema = z.object({
  phase: z.preprocess(value => value === null ? undefined : value, purchasePhaseSchema.optional()),
  id: z.uuid(),
  conversationId: z.uuid().optional(),
  prompt: z.string().min(1).max(2000),
  status: naRequestStatusSchema,
  response: z.string().optional(),
  orderId: z.uuid().optional(),
  title: z.string().optional(),
  // Legacy BSON records serialize an absent transaction signature as null.
  signature: z.preprocess(value => value === null ? undefined : value, z.string().optional()),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
})
export type NaRequest = z.infer<typeof naRequestSchema>
