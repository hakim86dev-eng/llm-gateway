export interface RateLimitDecision {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Seconds until the bucket is full again. */
  resetSeconds: number;
  /** Seconds until the next request would be allowed (0 when allowed). */
  retryAfterSeconds: number;
}

interface Bucket {
  tokens: number;
  updatedAt: number;
}

/**
 * Token-bucket rate limiter keyed by API key: `rpm` capacity, refilled continuously, so short
 * bursts are allowed while the long-run rate is capped. In-memory (single instance); the
 * interface is small enough to back with Redis for horizontal scaling.
 */
export class TokenBucketLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(private readonly now: () => number = Date.now) {}

  take(key: string, rpm: number): RateLimitDecision {
    const now = this.now();
    const refillPerMs = rpm / 60_000;
    const bucket = this.buckets.get(key) ?? { tokens: rpm, updatedAt: now };
    bucket.tokens = Math.min(rpm, bucket.tokens + (now - bucket.updatedAt) * refillPerMs);
    bucket.updatedAt = now;

    const allowed = bucket.tokens >= 1;
    if (allowed) bucket.tokens -= 1;
    this.buckets.set(key, bucket);

    const missing = rpm - bucket.tokens;
    return {
      allowed,
      limit: rpm,
      remaining: Math.floor(bucket.tokens),
      resetSeconds: Math.ceil(missing / refillPerMs / 1000),
      retryAfterSeconds: allowed
        ? 0
        : Math.max(1, Math.ceil((1 - bucket.tokens) / refillPerMs / 1000)),
    };
  }
}
