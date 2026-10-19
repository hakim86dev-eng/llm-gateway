import type { ProviderName } from './types.js';

/** Error raised by a provider adapter; carries enough context for retry/fallback decisions. */
export class ProviderError extends Error {
  override readonly name = 'ProviderError';

  constructor(
    message: string,
    readonly provider: ProviderName,
    readonly status: number | undefined,
    readonly retryable: boolean,
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }

  /** Whether trying the *next* provider could help (provider-side or config problems). */
  get fallbackable(): boolean {
    if (this.retryable) return true;
    return this.status === 401 || this.status === 403 || this.status === 404;
  }
}

/** Error surfaced to API clients, rendered in the OpenAI error format. */
export class GatewayError extends Error {
  override readonly name = 'GatewayError';

  constructor(
    readonly statusCode: number,
    message: string,
    readonly type:
      | 'invalid_request_error'
      | 'authentication_error'
      | 'rate_limit_error'
      | 'upstream_error'
      | 'server_error' = 'server_error',
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

export function parseRetryAfter(
  header: string | null,
  now: number = Date.now(),
): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}
