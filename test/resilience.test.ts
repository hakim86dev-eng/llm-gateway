import { describe, expect, it, vi } from 'vitest';
import { TtlLruCache, cacheKey } from '../src/core/cache.js';
import { CircuitBreaker } from '../src/core/circuitBreaker.js';
import { TokenBucketLimiter } from '../src/core/rateLimiter.js';
import { backoffDelay, withRetry } from '../src/core/retry.js';
import { ProviderError, parseRetryAfter } from '../src/errors.js';
import { noSleep } from './helpers.js';

const retryable = () => new ProviderError('boom', 'openai', 503, true);
const fatal = () => new ProviderError('bad request', 'openai', 400, false);

describe('withRetry', () => {
  it('retries retryable errors until success', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(retryable())
      .mockRejectedValueOnce(retryable())
      .mockResolvedValue('ok');
    const onRetry = vi.fn();
    await expect(
      withRetry(fn, { retries: 2, baseDelayMs: 1, maxDelayMs: 1, sleep: noSleep, onRetry }),
    ).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
    expect(onRetry).toHaveBeenCalledTimes(2);
  });

  it('gives up after the retry budget', async () => {
    const fn = vi.fn().mockRejectedValue(retryable());
    await expect(
      withRetry(fn, { retries: 1, baseDelayMs: 1, maxDelayMs: 1, sleep: noSleep }),
    ).rejects.toThrow('boom');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('does not retry non-retryable errors', async () => {
    const fn = vi.fn().mockRejectedValue(fatal());
    await expect(
      withRetry(fn, { retries: 5, baseDelayMs: 1, maxDelayMs: 1, sleep: noSleep }),
    ).rejects.toThrow('bad request');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('uses Retry-After when the provider sends it', async () => {
    const sleep = vi.fn(noSleep);
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new ProviderError('slow down', 'openai', 429, true, 1500))
      .mockResolvedValue(1);
    await withRetry(fn, { retries: 1, baseDelayMs: 1, maxDelayMs: 10_000, sleep });
    expect(sleep).toHaveBeenCalledWith(1500);
  });
});

describe('backoffDelay', () => {
  it('is bounded exponential with full jitter', () => {
    expect(backoffDelay(0, 100, 1000, () => 1)).toBe(100);
    expect(backoffDelay(3, 100, 1000, () => 1)).toBe(800);
    expect(backoffDelay(10, 100, 1000, () => 1)).toBe(1000);
    expect(backoffDelay(3, 100, 1000, () => 0)).toBe(0);
    expect(backoffDelay(0, 100, 1000, () => 1, 5000)).toBe(1000);
  });
});

describe('parseRetryAfter', () => {
  it('parses seconds and HTTP dates', () => {
    expect(parseRetryAfter('2')).toBe(2000);
    expect(parseRetryAfter(new Date(10_000).toUTCString(), 4_000)).toBe(6000);
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter('soon')).toBeUndefined();
  });
});

describe('CircuitBreaker', () => {
  it('opens after the threshold, half-opens after cooldown and closes on success', () => {
    let now = 0;
    const breaker = new CircuitBreaker(2, 1000, () => now);
    breaker.recordFailure();
    expect(breaker.state).toBe('closed');
    breaker.recordFailure();
    expect(breaker.state).toBe('open');
    expect(breaker.canRequest()).toBe(false);
    now = 1000;
    expect(breaker.state).toBe('half_open');
    breaker.recordFailure(); // trial failed -> open again
    expect(breaker.state).toBe('open');
    now = 2000;
    breaker.recordSuccess();
    expect(breaker.state).toBe('closed');
  });
});

describe('TtlLruCache', () => {
  it('expires entries after the TTL', () => {
    let now = 0;
    const cache = new TtlLruCache<string>(10, 100, () => now);
    cache.set('a', 'A');
    expect(cache.get('a')).toBe('A');
    now = 100;
    expect(cache.get('a')).toBeUndefined();
    expect(cache.size).toBe(0);
    expect([cache.hits, cache.misses]).toEqual([1, 1]);
  });

  it('evicts the least recently used entry', () => {
    const cache = new TtlLruCache<number>(2, 1000);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.get('a'); // a is now most recent
    cache.set('c', 3);
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBe(1);
    expect(cache.get('c')).toBe(3);
  });

  it('is disabled with a zero TTL', () => {
    const cache = new TtlLruCache<number>(2, 0);
    cache.set('a', 1);
    expect(cache.size).toBe(0);
  });
});

describe('cacheKey', () => {
  it('is stable across key order and ignores undefined fields', () => {
    const messages = [{ role: 'user' as const, content: 'hi' }];
    const a = cacheKey('fast', { messages, temperature: 0, maxTokens: undefined });
    const b = cacheKey('fast', { temperature: 0, messages });
    expect(a).toBe(b);
    expect(cacheKey('smart', { messages, temperature: 0 })).not.toBe(a);
  });
});

describe('TokenBucketLimiter', () => {
  it('allows a burst up to the limit, then refills over time', () => {
    let now = 0;
    const limiter = new TokenBucketLimiter(() => now);
    const decisions = [1, 2, 3].map(() => limiter.take('k', 2));
    expect(decisions.map((d) => d.allowed)).toEqual([true, true, false]);
    expect(decisions[2]?.retryAfterSeconds).toBe(30);
    expect(decisions[1]?.remaining).toBe(0);
    now = 30_000; // 2 rpm -> one token every 30s
    expect(limiter.take('k', 2).allowed).toBe(true);
    expect(limiter.take('other', 2).allowed).toBe(true); // independent buckets
  });
});
