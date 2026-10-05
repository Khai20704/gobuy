export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN'
export class CircuitBreaker {
  private state: CircuitState = 'CLOSED'
  private failures = 0
  private openedAt = 0
  private generation = 0
  constructor(private readonly threshold = 3, private readonly cooldownMs = 60000, private readonly now = Date.now) {}
  acquire(): number | undefined {
    if (this.state === 'HALF_OPEN') return undefined
    if (this.state === 'OPEN') {
      if (this.now() - this.openedAt < this.cooldownMs) return undefined
      this.state = 'HALF_OPEN'
    }
    return this.generation
  }
  success(ticket: number) {
    if (ticket !== this.generation) return
    this.state = 'CLOSED'; this.failures = 0; this.generation++
  }
  failure(ticket: number) {
    if (ticket !== this.generation) return
    if (++this.failures >= this.threshold || this.state === 'HALF_OPEN') {
      this.state = 'OPEN'; this.openedAt = this.now(); this.generation++
    }
  }
  // A request-specific failure is not evidence that the provider is unhealthy.
  release(ticket: number) {
    if (ticket === this.generation && this.state === 'HALF_OPEN') { this.state = 'CLOSED'; this.failures = 0; this.generation++ }
  }
  snapshot() { return { state: this.state, failures: this.failures } }
}
