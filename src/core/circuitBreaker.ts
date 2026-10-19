export type CircuitState = 'closed' | 'open' | 'half_open';

/**
 * Per-provider circuit breaker. After `failureThreshold` consecutive failures the circuit opens
 * and the provider is skipped (so fallback is instant) until `cooldownMs` has elapsed; then a
 * trial request is allowed (half-open). Success closes the circuit, failure re-opens it.
 */
export class CircuitBreaker {
  private failures = 0;
  private openedAt: number | undefined;

  constructor(
    private readonly failureThreshold: number,
    private readonly cooldownMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  get state(): CircuitState {
    if (this.openedAt === undefined) return 'closed';
    return this.now() - this.openedAt >= this.cooldownMs ? 'half_open' : 'open';
  }

  canRequest(): boolean {
    return this.state !== 'open';
  }

  recordSuccess(): void {
    this.failures = 0;
    this.openedAt = undefined;
  }

  recordFailure(): void {
    if (this.state === 'half_open') {
      this.openedAt = this.now();
      return;
    }
    this.failures += 1;
    if (this.failures >= this.failureThreshold) this.openedAt = this.now();
  }
}
