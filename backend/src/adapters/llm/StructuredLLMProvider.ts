import type { LLMMessage } from '../../ai/LLMProvider.js'

export interface StructuredOptions {
  onProvider?: (value: { provider: string; fallback: boolean }) => void
  validate?: (value: unknown) => unknown
  protectedContext?: Record<string, unknown>
  messages?: LLMMessage[]
  totalTimeoutMs?: number
}
// Na's existing business interface remains provider independent.
export interface StructuredLLMProvider {
  generate(instructions: string, input: unknown, schema: Record<string, unknown>, name: string, options?: StructuredOptions): Promise<unknown>
}
