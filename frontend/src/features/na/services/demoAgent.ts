import type { Proposal } from '../domain/types'
// A replaceable adapter. This fixture never calls an AI or marketplace API.
export async function discoverDemo(scenario: 'within' | 'outside'): Promise<Proposal> {
  await new Promise(resolve => setTimeout(resolve, 650))
  return { id: crypto.randomUUID(), title: 'Quiet forms / Study 08', amount: scenario === 'outside' ? 280 : 170, verified: true }
}
