import { z } from 'zod'
import { assetStore, type AssetStore } from '../../persistence/AssetStore.js'

/**
 * Off-chain index for autonomous vault spends.
 *
 * The program's `SpendRecord` is authoritative for amounts and timestamps, but it deliberately
 * stores no transaction signature and no free-form label: both would cost rent forever. This index
 * supplies exactly those two fields and nothing that could be mistaken for budget state.
 */

export const mandateSpendNoteSchema = z.object({
  spendId: z.string().regex(/^[0-9a-f]{32}$/),
  owner: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/),
  reference: z.string().min(1).max(120),
  assetHash: z.string().regex(/^[0-9a-f]{64}$/),
  signature: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{43,88}$/),
  amountLamports: z.string().regex(/^[1-9]\d{0,15}$/),
  createdAt: z.iso.datetime(),
}).strict()
export type MandateSpendNote = z.infer<typeof mandateSpendNoteSchema>

const notes: AssetStore<MandateSpendNote> = assetStore<MandateSpendNote>('mandateSpendNotes')

export async function recordSpendNote(userId: string, note: MandateSpendNote): Promise<void> {
  await notes.put(userId, note.spendId, note)
}

/**
 * Notes keyed by `spendId`. A malformed stored entry is skipped rather than surfaced: it can only
 * ever remove a label, never change an on-chain amount.
 */
export async function spendNoteIndex(userId: string): Promise<Map<string, MandateSpendNote>> {
  const stored = await notes.list(userId, 500)
  const index = new Map<string, MandateSpendNote>()
  for (const value of stored) {
    const parsed = mandateSpendNoteSchema.safeParse(value)
    if (parsed.success) index.set(parsed.data.spendId, parsed.data)
  }
  return index
}
