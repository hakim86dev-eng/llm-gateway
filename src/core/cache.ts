import { createHash } from 'node:crypto';
import type { ChatRequest } from '../types.js';

interface Entry<V> {
  value: V;
  expiresAt: number;
}

/** Small LRU cache with per-entry TTL (Map preserves insertion order -> O(1) LRU). */
export class TtlLruCache<V> {
  private readonly entries = new Map<string, Entry<V>>();
  hits = 0;
  misses = 0;

  constructor(
    private readonly maxEntries: number,
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  get size(): number {
    return this.entries.size;
  }

  get(key: string): V | undefined {
    const entry = this.entries.get(key);
    if (!entry || entry.expiresAt <= this.now()) {
      if (entry) this.entries.delete(key);
      this.misses += 1;
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, entry); // mark as most recently used
    this.hits += 1;
    return entry.value;
  }

  set(key: string, value: V): void {
    if (this.ttlMs <= 0) return;
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: this.now() + this.ttlMs });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, stable(v)]),
    );
  }
  return value;
}

/** Deterministic cache key: same logical request (any key order) -> same hash. */
export function cacheKey(requestedModel: string, request: Omit<ChatRequest, 'model'>): string {
  return createHash('sha256')
    .update(JSON.stringify(stable({ ...request, model: requestedModel })))
    .digest('hex');
}
