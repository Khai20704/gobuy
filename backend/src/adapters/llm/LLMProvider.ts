import type { SearchRequest } from '@gobuy/shared'
export type DiscoveryIntent = { query: string; scenario: SearchRequest['scenario'] }
export interface LLMProvider {
  interpret(request: SearchRequest): Promise<DiscoveryIntent>
}
export class MockLLMProvider implements LLMProvider {
  async interpret(request: SearchRequest): Promise<DiscoveryIntent> {
    // Explicit mock: no model call and no visual understanding.
    return { query: request.text, scenario: request.scenario }
  }
}
