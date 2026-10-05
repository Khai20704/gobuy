import type { StructuredLLMProvider, StructuredOptions } from './StructuredLLMProvider.js'
import { LLMRouter, parseModelJSON } from '../../ai/LLMRouter.js'

export class RoutedStructuredLLMProvider implements StructuredLLMProvider {
  constructor(private readonly router: LLMRouter) {}
  async generate(instructions: string, input: unknown, schema: Record<string, unknown>, name: string, options: StructuredOptions = {}) {
    const response = await this.router.generate({
      operation: name, systemPrompt: instructions,
      messages: [...options.messages ?? [], { role: 'user', content: JSON.stringify(input) }],
      protectedContext: options.protectedContext, responseFormat: 'json', jsonSchema: { name, schema },
      validate: options.validate, totalTimeoutMs: options.totalTimeoutMs,
    })
    options.onProvider?.({ provider: response.provider, fallback: (response.failoverCount ?? 0) > 0 })
    return parseModelJSON(response.content)
  }
}
