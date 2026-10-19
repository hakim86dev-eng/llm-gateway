import { GatewayError, ProviderError } from '../errors.js';
import type { ChatRequest, ChatResult, LLMProvider, ProviderName, StreamChunk } from '../types.js';
import { cacheKey, type TtlLruCache } from './cache.js';
import { CircuitBreaker } from './circuitBreaker.js';
import { withRetry, type RetryOptions } from './retry.js';
import type { ModelRouter, Target } from './router.js';

export interface Attempt {
  provider: ProviderName;
  model: string;
  ok: boolean;
  status?: number;
  error?: string;
}

export interface CompletionOutcome {
  result: ChatResult;
  target: Target;
  attempts: Attempt[];
  cached: boolean;
}

export interface StreamOutcome {
  target: Target;
  attempts: Attempt[];
  chunks: AsyncIterable<StreamChunk>;
}

export interface CachedCompletion {
  result: ChatResult;
  target: Target;
}

export interface GatewayRequest extends Omit<ChatRequest, 'model'> {
  /** Model as requested by the client (alias, provider/model, or bare model name). */
  model: string;
}

export interface CallContext {
  signal?: AbortSignal;
  useCache?: boolean;
}

export interface GatewayDeps {
  providers: ReadonlyMap<ProviderName, LLMProvider>;
  router: ModelRouter;
  cache?: TtlLruCache<CachedCompletion> | undefined;
  retry: Omit<RetryOptions, 'shouldRetry' | 'onRetry'>;
  timeoutMs: number;
  circuit: { failureThreshold: number; cooldownMs: number };
  now?: () => number;
  onEvent?: (event: string, data: Record<string, unknown>) => void;
}

const isClientAbort = (error: unknown, signal?: AbortSignal): boolean =>
  signal?.aborted === true && !(error instanceof ProviderError);

function toProviderError(error: unknown, provider: ProviderName): ProviderError {
  if (error instanceof ProviderError) return error;
  if (error instanceof Error && error.name === 'TimeoutError') {
    return new ProviderError(`${provider} timed out`, provider, 504, true);
  }
  const message = error instanceof Error ? error.message : String(error);
  return new ProviderError(`${provider} failed: ${message}`, provider, undefined, true);
}

/** Timeout signal that also follows the caller's (client disconnect) signal. */
function deadline(
  timeoutMs: number,
  parent?: AbortSignal,
): { signal: AbortSignal; aborted: Promise<never>; clear: () => void } {
  const controller = new AbortController();
  // Rejects when the signal fires, so a provider that ignores AbortSignal still cannot hang us.
  const aborted = new Promise<never>((_, reject) => {
    controller.signal.addEventListener(
      'abort',
      () => {
        reject(controller.signal.reason as Error);
      },
      { once: true },
    );
  });
  aborted.catch(() => undefined);
  const timer = setTimeout(() => {
    controller.abort(new DOMException('provider timed out', 'TimeoutError'));
  }, timeoutMs);
  const onAbort = () => {
    controller.abort(parent?.reason);
  };
  parent?.addEventListener('abort', onAbort, { once: true });
  return {
    signal: controller.signal,
    aborted,
    // Only the timer is cleared: the client-disconnect link must outlive the first chunk so an
    // in-flight stream is cancelled upstream when the client goes away.
    clear: () => {
      clearTimeout(timer);
    },
  };
}

/**
 * Core request pipeline: cache -> route -> (circuit breaker -> retry with backoff -> timeout)
 * per target -> fall back to the next target on provider-side failures.
 */
export class Gateway {
  private readonly breakers = new Map<ProviderName, CircuitBreaker>();

  constructor(private readonly deps: GatewayDeps) {}

  breaker(provider: ProviderName): CircuitBreaker {
    let breaker = this.breakers.get(provider);
    if (!breaker) {
      const { failureThreshold, cooldownMs } = this.deps.circuit;
      breaker = new CircuitBreaker(failureThreshold, cooldownMs, this.deps.now);
      this.breakers.set(provider, breaker);
    }
    return breaker;
  }

  private provider(target: Target): LLMProvider {
    const provider = this.deps.providers.get(target.provider);
    if (!provider) throw new GatewayError(500, `provider ${target.provider} not registered`);
    return provider;
  }

  private async runWithFallback<T>(
    request: GatewayRequest,
    ctx: CallContext,
    call: (provider: LLMProvider, req: ChatRequest, signal: AbortSignal) => Promise<T>,
  ): Promise<{ value: T; target: Target; attempts: Attempt[] }> {
    const targets = this.deps.router.resolve(request.model);
    const attempts: Attempt[] = [];
    let lastError: ProviderError | undefined;

    for (const target of targets) {
      const breaker = this.breaker(target.provider);
      if (!breaker.canRequest()) {
        attempts.push({ ...target, ok: false, error: 'circuit open' });
        continue;
      }
      const provider = this.provider(target);
      try {
        const value = await withRetry(
          async () => {
            const { signal, aborted, clear } = deadline(this.deps.timeoutMs, ctx.signal);
            try {
              const result = await Promise.race([
                call(provider, { ...request, model: target.model }, signal),
                aborted,
              ]);
              attempts.push({ ...target, ok: true });
              return result;
            } catch (error) {
              if (isClientAbort(error, ctx.signal)) throw error;
              const providerError = toProviderError(error, target.provider);
              attempts.push({
                ...target,
                ok: false,
                ...(providerError.status === undefined ? {} : { status: providerError.status }),
                error: providerError.message,
              });
              throw providerError;
            } finally {
              clear();
            }
          },
          {
            ...this.deps.retry,
            onRetry: (error, attempt, delayMs) => {
              this.deps.onEvent?.('retry', { ...target, attempt, delayMs, error: String(error) });
            },
          },
        );
        breaker.recordSuccess();
        return { value, target, attempts };
      } catch (error) {
        if (isClientAbort(error, ctx.signal)) throw error;
        const providerError = toProviderError(error, target.provider);
        lastError = providerError;
        if (!providerError.fallbackable) {
          // The request itself is bad (e.g. 400): other providers would reject it too.
          throw new GatewayError(
            providerError.status && providerError.status < 500 ? providerError.status : 502,
            providerError.message,
            'invalid_request_error',
            { attempts },
          );
        }
        breaker.recordFailure();
        this.deps.onEvent?.('fallback', { ...target, error: providerError.message });
      }
    }
    throw new GatewayError(
      lastError ? 502 : 503,
      lastError
        ? `all providers failed for "${request.model}": ${lastError.message}`
        : `no provider available for "${request.model}" (circuits open)`,
      'upstream_error',
      { attempts },
    );
  }

  async complete(request: GatewayRequest, ctx: CallContext = {}): Promise<CompletionOutcome> {
    const { model, ...rest } = request;
    const cacheable =
      Boolean(this.deps.cache) && (ctx.useCache ?? true) && request.temperature === 0;
    const key = cacheable ? cacheKey(model, rest) : undefined;
    if (key) {
      const hit = this.deps.cache?.get(key);
      if (hit) return { ...hit, attempts: [], cached: true };
    }
    const { value, target, attempts } = await this.runWithFallback(
      request,
      ctx,
      (provider, req, signal) => provider.chat(req, { signal }),
    );
    if (key) this.deps.cache?.set(key, { result: value, target });
    return { result: value, target, attempts, cached: false };
  }

  /**
   * Streams from the first healthy provider. Retries and fallback happen until the first chunk
   * arrives (time-to-first-token is covered by the timeout); after that the stream is committed.
   */
  async stream(request: GatewayRequest, ctx: CallContext = {}): Promise<StreamOutcome> {
    const { value, target, attempts } = await this.runWithFallback(
      request,
      ctx,
      async (provider, req, signal) => {
        const iterator = provider.stream(req, { signal })[Symbol.asyncIterator]();
        const first = await iterator.next();
        return { iterator, first };
      },
    );
    const { iterator, first } = value;
    async function* chunks(): AsyncGenerator<StreamChunk> {
      if (first.done) return;
      yield first.value;
      for (;;) {
        const next = await iterator.next();
        if (next.done) return;
        yield next.value;
      }
    }
    return { target, attempts, chunks: chunks() };
  }
}
