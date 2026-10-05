import type { Message, Transaction } from '@solana/web3.js'

/**
 * Immutable, primitive-only snapshots of a legacy transaction MESSAGE.
 *
 * Everything Phantom must not change lives in the compiled message: the fee payer, the recent
 * blockhash, the required signers and every instruction (program id, ordered account metas with
 * their signer/writable flags, and data). A snapshot keeps only strings, booleans and numbers, so
 * nothing here can be mutated through a retained PublicKey, TransactionInstruction or array.
 *
 * `messageHex` is the exact `serializeMessage()` payload the wallet is asked to sign, captured as a
 * detached hex string so a later in-place mutation of the transaction cannot rewrite the record.
 */

export interface AccountMetaSnapshot {
  pubkey: string
  isSigner: boolean
  isWritable: boolean
}

export interface InstructionSnapshot {
  index: number
  programId: string
  keys: AccountMetaSnapshot[]
  dataHex: string
}

export interface MessageSnapshot {
  messageHex: string
  feePayer: string | null
  recentBlockhash: string | null
  requiredSigners: string[]
  instructionCount: number
  instructions: InstructionSnapshot[]
}

export type InstructionField = 'programId' | 'keys' | 'data'

/** Solana's ComputeBudget program: compute unit limit, unit price, heap frame. */
export const COMPUTE_BUDGET_PROGRAM_ID = 'ComputeBudget111111111111111111111111111111'

/**
 * True for a ComputeBudget instruction that references NO accounts.
 *
 * Wallets (Phantom included) inject these while signing to set the compute unit limit and priority
 * fee. Because they carry no account metas they cannot move SOL, add a signer or touch the mandate
 * vault, so they are the only instruction a wallet may add without invalidating the transaction.
 */
export function isComputeBudgetInstruction(instruction: InstructionSnapshot): boolean {
  return instruction.programId === COMPUTE_BUDGET_PROGRAM_ID && instruction.keys.length === 0
}

export interface InstructionChange {
  index: number
  programId: string
  fields: InstructionField[]
  before: InstructionSnapshot
  after: InstructionSnapshot
}

export interface MessageDiff {
  instructionCountBefore: number
  instructionCountAfter: number
  addedInstructions: InstructionSnapshot[]
  removedInstructions: InstructionSnapshot[]
  changedInstructions: InstructionChange[]
  /** Added instructions that are zero-account ComputeBudget configuration a wallet may inject safely. */
  computeBudgetAdded: InstructionSnapshot[]
  /** Added instructions that are NOT ComputeBudget configuration: a real mutation of the message. */
  unexpectedAdded: InstructionSnapshot[]
  messageHexBefore: string
  messageHexAfter: string
  /** Protected content is identical: payer, blockhash, signers and every non-ComputeBudget instruction. */
  messagesEqual: boolean
  instructionsEqual: boolean
}

const HEX_DIGITS = '0123456789abcdef'

/** Hex string for any byte view. Implemented directly so no Buffer polyfill is required. */
export function bytesToHex(bytes: Uint8Array): string {
  let hex = ''
  for (const byte of bytes) hex += HEX_DIGITS[byte >> 4] + HEX_DIGITS[byte & 0x0f]
  return hex
}

function snapshotInstruction(message: Message, index: number): InstructionSnapshot {
  const compiled = message.compiledInstructions[index]
  return {
    index,
    programId: message.accountKeys[compiled.programIdIndex].toBase58(),
    keys: compiled.accountKeyIndexes.map(keyIndex => ({
      pubkey: message.accountKeys[keyIndex].toBase58(),
      isSigner: message.isAccountSigner(keyIndex),
      isWritable: message.isAccountWritable(keyIndex),
    })),
    dataHex: bytesToHex(compiled.data),
  }
}

/** Snapshots a compiled message: the exact bytes the wallet is asked to sign. */
export function snapshotMessage(message: Message): MessageSnapshot {
  const instructions = Array.from({ length: message.compiledInstructions.length }, (_unused, index) => snapshotInstruction(message, index))
  const requiredSigners = message.accountKeys.slice(0, message.header.numRequiredSignatures).map(key => key.toBase58())
  return {
    messageHex: bytesToHex(message.serialize()),
    feePayer: message.header.numRequiredSignatures > 0 ? requiredSigners[0] : null,
    recentBlockhash: message.recentBlockhash ?? null,
    requiredSigners,
    instructionCount: instructions.length,
    instructions,
  }
}

/** Compiles the transaction once and snapshots the resulting message. */
export function snapshotTransaction(transaction: Transaction): MessageSnapshot {
  return snapshotMessage(transaction.compileMessage())
}

function canonicalInstruction(instruction: InstructionSnapshot): string {
  const keys = instruction.keys.map(key => key.pubkey + (key.isSigner ? 'S' : '-') + (key.isWritable ? 'W' : '-')).join(',')
  return instruction.programId + '|' + keys + '|' + instruction.dataHex
}

/** Indexes of instructions whose content appears fewer times in `other` (a multiset difference). */
function indexesMissingFrom(source: InstructionSnapshot[], other: InstructionSnapshot[]): number[] {
  const remaining = new Map<string, number>()
  for (const instruction of other) {
    const key = canonicalInstruction(instruction)
    remaining.set(key, (remaining.get(key) ?? 0) + 1)
  }
  const missing: number[] = []
  source.forEach((instruction, index) => {
    const key = canonicalInstruction(instruction)
    const count = remaining.get(key) ?? 0
    if (count > 0) remaining.set(key, count - 1)
    else missing.push(index)
  })
  return missing
}

function changedFields(before: InstructionSnapshot, after: InstructionSnapshot): InstructionField[] {
  const fields: InstructionField[] = []
  if (before.programId !== after.programId) fields.push('programId')
  if (JSON.stringify(before.keys) !== JSON.stringify(after.keys)) fields.push('keys')
  if (before.dataHex !== after.dataHex) fields.push('data')
  return fields
}

/** The non-ComputeBudget instruction lists must match exactly, in order, for the message to be intact. */
function protectedInstructionsEqual(before: MessageSnapshot, after: MessageSnapshot): boolean {
  const expected = before.instructions.filter(instruction => !isComputeBudgetInstruction(instruction))
  const actual = after.instructions.filter(instruction => !isComputeBudgetInstruction(instruction))
  return expected.length === actual.length &&
    expected.every((instruction, index) => canonicalInstruction(instruction) === canonicalInstruction(actual[index]))
}

/**
 * True when the ONLY instruction difference is that the wallet ADDED zero-account ComputeBudget
 * configuration (compute unit limit and priority fee). A wallet may inject those; it may not remove
 * or edit an instruction we built, not even a ComputeBudget one.
 */
export function onlyComputeBudgetInstructionsChanged(diff: MessageDiff): boolean {
  return diff.unexpectedAdded.length === 0 && diff.removedInstructions.length === 0 && diff.changedInstructions.length === 0
}

/**
 * Field-by-field diff between the pre-sign and post-sign snapshots. Instructions are matched by
 * content, so an instruction Phantom appended is reported as added even when it shifts the indexes
 * of the instructions after it, and a mutated instruction is reported as changed.
 */
export function diffMessageSnapshots(before: MessageSnapshot, after: MessageSnapshot): MessageDiff {
  const removedIndexes = indexesMissingFrom(before.instructions, after.instructions)
  const addedIndexes = indexesMissingFrom(after.instructions, before.instructions)
  const paired = Math.min(removedIndexes.length, addedIndexes.length)
  const changedInstructions: InstructionChange[] = Array.from({ length: paired }, (_unused, position) => {
    const previous = before.instructions[removedIndexes[position]]
    const next = after.instructions[addedIndexes[position]]
    return { index: next.index, programId: next.programId, fields: changedFields(previous, next), before: previous, after: next }
  })
  const addedInstructions = addedIndexes.slice(paired).map(index => after.instructions[index])
  const protectedEqual = protectedInstructionsEqual(before, after)
  return {
    instructionCountBefore: before.instructionCount,
    instructionCountAfter: after.instructionCount,
    addedInstructions,
    removedInstructions: removedIndexes.slice(paired).map(index => before.instructions[index]),
    changedInstructions,
    computeBudgetAdded: addedInstructions.filter(isComputeBudgetInstruction),
    unexpectedAdded: addedInstructions.filter(instruction => !isComputeBudgetInstruction(instruction)),
    messageHexBefore: before.messageHex,
    messageHexAfter: after.messageHex,
    messagesEqual: protectedEqual && before.feePayer === after.feePayer &&
      before.recentBlockhash === after.recentBlockhash &&
      JSON.stringify(before.requiredSigners) === JSON.stringify(after.requiredSigners),
    instructionsEqual: protectedEqual,
  }
}

/** One-line, human-readable summary of what changed, for the fail-closed error message. */
export function describeMessageDiff(diff: MessageDiff): string {
  const parts: string[] = []
  if (diff.addedInstructions.length > 0) {
    parts.push('Phantom thêm ' + diff.addedInstructions.length + ' lệnh (' +
      diff.addedInstructions.map(instruction => '#' + instruction.index + ' ' + instruction.programId).join(', ') + ')')
  }
  if (diff.removedInstructions.length > 0) {
    parts.push('Phantom bỏ ' + diff.removedInstructions.length + ' lệnh (' +
      diff.removedInstructions.map(instruction => '#' + instruction.index + ' ' + instruction.programId).join(', ') + ')')
  }
  if (diff.changedInstructions.length > 0) {
    parts.push('Phantom đổi ' + diff.changedInstructions.length + ' lệnh (' +
      diff.changedInstructions.map(change => '#' + change.index + ' ' + change.fields.join('/')).join(', ') + ')')
  }
  if (parts.length === 0) return 'Message bytes differ.'
  return (onlyComputeBudgetInstructionsChanged(diff) ? 'Chỉ thêm cấu hình ComputeBudget: ' : '') + parts.join('; ') + '.'
}
