import { InputError } from '../../schemas/search.js'

/** Only thrown by pre-execution validation, never after an order may have been submitted. */
export class AutonomousSpendBlockedError extends InputError {
  readonly executionStarted = false
}
