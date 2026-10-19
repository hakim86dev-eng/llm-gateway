import { ProviderError } from '../errors.js';

export interface RetryOptions {
  retries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  shouldRetry?: (error: unknown) => boolean;
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
}

export const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Exponential backoff with "full jitter"; honours a server-provided Retry-After when present. */
export function backoffDelay(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
  random: () => number = Math.random,
  retryAfterMs?: number,
): number {
  if (retryAfterMs !== undefined) return Math.min(retryAfterMs, maxDelayMs);
  const ceiling = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
  return Math.round(random() * ceiling);
}

const retryableByDefault = (error: unknown): boolean =>
  error instanceof ProviderError && error.retryable;

export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  options: RetryOptions,
): Promise<T> {
  const sleep = options.sleep ?? defaultSleep;
  const shouldRetry = options.shouldRetry ?? retryableByDefault;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (error) {
      if (attempt >= options.retries || !shouldRetry(error)) throw error;
      const retryAfter = error instanceof ProviderError ? error.retryAfterMs : undefined;
      const delay = backoffDelay(
        attempt,
        options.baseDelayMs,
        options.maxDelayMs,
        options.random,
        retryAfter,
      );
      options.onRetry?.(error, attempt + 1, delay);
      await sleep(delay);
    }
  }
}
