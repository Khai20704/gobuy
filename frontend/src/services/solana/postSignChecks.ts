import type { Transaction } from '@solana/web3.js'
import { diffMessageSnapshots, isComputeBudgetInstruction, type MessageDiff, type MessageSnapshot } from './messageSnapshot'

/**
 * Post-sign safety comparison for the legacy owner transactions (CreateMandate / revoke / withdraw).
 *
 * Phantom is EXPECTED to add the user's signature, so signature slots and the serialized wire bytes
 * are allowed to differ. Phantom also injects zero-account ComputeBudget instructions to set the
 * compute unit limit and priority fee; those carry no accounts, so they cannot move SOL, add a
 * signer or touch the mandate, and are ignored here. What must NOT change is the protected MESSAGE:
 * payer, blockhash, required signers and every non-ComputeBudget instruction. This module compares
 * two immutable primitive snapshots of that message (see `messageSnapshot.ts`) and reports, fact by
 * fact, whether the signed message still matches the one that was shown to the user.
 *
 * A malformed signed transaction is never reported as "differs": snapshotting throws and the caller
 * fails closed, so a comparison that cannot be performed can never look like a passed check.
 */

export type { InstructionField, InstructionSnapshot, MessageDiff, MessageSnapshot } from './messageSnapshot'
export { snapshotTransaction } from './messageSnapshot'

export interface PostSignChecks {
  messageBytesEqual: boolean
  feePayerEqual: boolean
  blockhashEqual: boolean
  requiredSignersEqual: boolean
  instructionCountEqual: boolean
  programIdsEqual: boolean
  accountMetasEqual: boolean
  instructionDataEqual: boolean
  /** No instruction was added (other than ComputeBudget), removed or changed. */
  noUnexpectedInstructionChanges: boolean
  /** Composite of the instruction checks; true only when the protected instruction list is untouched. */
  instructionsEqual: boolean
  phantomSignaturePresent: boolean
  phantomSignatureValid: boolean
  connectedWalletEqual: boolean
}

export interface PostSignReport {
  checks: PostSignChecks
  diff: MessageDiff
}

/** Ed25519 signatures are always 64 bytes. */
const ED25519_SIGNATURE_BYTES = 64

function instructionChecks(before: MessageSnapshot, after: MessageSnapshot, diff: MessageDiff) {
  // ComputeBudget configuration is ignored on both sides: it carries no accounts, so a wallet may
  // change the compute unit limit and priority fee without touching the mandate instruction.
  const expected = before.instructions.filter(instruction => !isComputeBudgetInstruction(instruction))
  const actual = after.instructions.filter(instruction => !isComputeBudgetInstruction(instruction))
  const countEqual = expected.length === actual.length
  // Only ADDED zero-account ComputeBudget instructions are tolerated. Removing or editing an
  // instruction we built is a mutation, even if it is a ComputeBudget one we added ourselves.
  const benignOnly = diff.unexpectedAdded.length === 0 &&
    diff.removedInstructions.length === 0 &&
    diff.changedInstructions.length === 0
  if (!countEqual) return { countEqual, programIdsEqual: false, accountMetasEqual: false, dataEqual: false, benignOnly }
  return {
    countEqual,
    programIdsEqual: expected.every((instruction, index) => instruction.programId === actual[index].programId),
    accountMetasEqual: expected.every((instruction, index) => JSON.stringify(instruction.keys) === JSON.stringify(actual[index].keys)),
    dataEqual: expected.every((instruction, index) => instruction.dataHex === actual[index].dataHex),
    benignOnly,
  }
}

export function postSignReport(before: MessageSnapshot, after: MessageSnapshot, signed: Transaction, signer: string | undefined, connectedWallet: string | undefined): PostSignReport {
  const diff = diffMessageSnapshots(before, after)
  const signatureSlot = signer ? signed.signatures.find(slot => slot.publicKey.toBase58() === signer) : undefined
  const phantomSignaturePresent = signatureSlot?.signature != null
  const instructionFacts = instructionChecks(before, after, diff)
  return {
    diff,
    checks: {
      messageBytesEqual: diff.messagesEqual,
      feePayerEqual: before.feePayer === after.feePayer,
      blockhashEqual: before.recentBlockhash === after.recentBlockhash,
      requiredSignersEqual: JSON.stringify(before.requiredSigners) === JSON.stringify(after.requiredSigners),
      instructionCountEqual: instructionFacts.countEqual,
      programIdsEqual: instructionFacts.programIdsEqual,
      accountMetasEqual: instructionFacts.accountMetasEqual,
      instructionDataEqual: instructionFacts.dataEqual,
      noUnexpectedInstructionChanges: instructionFacts.benignOnly,
      instructionsEqual: instructionFacts.countEqual && instructionFacts.programIdsEqual && instructionFacts.accountMetasEqual &&
        instructionFacts.dataEqual && instructionFacts.benignOnly,
      phantomSignaturePresent,
      // Verified against the POST-SIGN message the wallet actually returned, never against a
      // reconstruction of the signed transaction.
      phantomSignatureValid: phantomSignaturePresent && signatureSlot!.signature!.length === ED25519_SIGNATURE_BYTES && safeVerifySignatures(signed),
      // Re-reads the wallet AFTER signing: a wallet/account swap during the prompt must fail closed.
      connectedWalletEqual: connectedWallet !== undefined && connectedWallet === signer,
    },
  }
}

/** The signature must verify against the message we snapshotted; anything unverifiable is invalid. */
function safeVerifySignatures(signed: Transaction): boolean {
  try { return signed.verifySignatures(false) } catch { return false }
}

export function collectPostSignChecks(before: MessageSnapshot, after: MessageSnapshot, signed: Transaction, signer: string | undefined, connectedWallet: string | undefined): PostSignChecks {
  return postSignReport(before, after, signed, signer, connectedWallet).checks
}

/** True only when every semantic message check passed AND Phantom added a valid signature. */
export function allPostSignChecksPass(checks: PostSignChecks): boolean {
  return Object.values(checks).every(Boolean)
}

/** Keys that failed, in object order, for the failure log and error message. */
export function failedPostSignChecks(checks: PostSignChecks): string[] {
  return Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name)
}
