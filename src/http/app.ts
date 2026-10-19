import { randomUUID } from 'node:crypto';
import fastifySwagger from '@fastify/swagger';
import fastifySwaggerUi from '@fastify/swagger-ui';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import {
  hasZodFastifySchemaValidationErrors,
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import type { GatewayConfig } from '../config.js';
import { ApiKeyStore, type ApiKeyRecord } from '../core/auth.js';
import { TtlLruCache } from '../core/cache.js';
import { Gateway, type CachedCompletion, type GatewayRequest } from '../core/gateway.js';
import { TokenBucketLimiter } from '../core/rateLimiter.js';
import { ModelRouter } from '../core/router.js';
import { UsageTracker, jsonlSink, type UsageSink } from '../core/usage.js';
import { GatewayError } from '../errors.js';
import {
  AnthropicProvider,
  MockProvider,
  OllamaProvider,
  OpenAIProvider,
} from '../providers/index.js';
import type { FetchFn, LLMProvider, ProviderName, Usage } from '../types.js';
import { estimateTokens, makeUsage } from '../types.js';
import {
  ChatCompletionRequestSchema,
  ChatCompletionResponseSchema,
  ErrorSchema,
  HealthSchema,
  ModelsResponseSchema,
  UsageSummarySchema,
  type ChatCompletionRequest,
} from './schemas.js';

declare module 'fastify' {
  interface FastifyRequest {
    apiKey?: ApiKeyRecord;
  }
}

export interface AppOptions {
  config: GatewayConfig;
  /** Override provider adapters (tests, custom providers). */
  providers?: Partial<Record<ProviderName, LLMProvider>>;
  fetch?: FetchFn;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  usageSink?: UsageSink;
  logger?: boolean;
}

export function createProviders(
  config: GatewayConfig,
  fetchFn?: FetchFn,
): Map<ProviderName, LLMProvider> {
  const providers = new Map<ProviderName, LLMProvider>();
  const f = fetchFn ? { fetch: fetchFn } : {};
  if (config.openai) providers.set('openai', new OpenAIProvider({ ...config.openai, ...f }));
  if (config.anthropic)
    providers.set('anthropic', new AnthropicProvider({ ...config.anthropic, ...f }));
  if (config.ollama) providers.set('ollama', new OllamaProvider({ ...config.ollama, ...f }));
  if (config.enableMock) providers.set('mock', new MockProvider());
  return providers;
}

function toGatewayRequest(body: ChatCompletionRequest): GatewayRequest {
  return {
    model: body.model,
    messages: body.messages,
    temperature: body.temperature,
    maxTokens: body.max_tokens,
    topP: body.top_p,
    stop: typeof body.stop === 'string' ? [body.stop] : body.stop,
  };
}

const openAIUsage = (u: Usage) => ({
  prompt_tokens: u.promptTokens,
  completion_tokens: u.completionTokens,
  total_tokens: u.totalTokens,
});

export async function buildApp(options: AppOptions): Promise<FastifyInstance> {
  const { config } = options;
  const now = options.now ?? Date.now;
  const startedAt = now();

  const providers = createProviders(config, options.fetch);
  for (const [name, provider] of Object.entries(options.providers ?? {})) {
    providers.set(name as ProviderName, provider);
  }

  const router = new ModelRouter(config.routes, new Set(providers.keys()));
  const cache =
    config.cache.ttlMs > 0
      ? new TtlLruCache<CachedCompletion>(config.cache.maxEntries, config.cache.ttlMs, now)
      : undefined;
  const keys = new ApiKeyStore(config.apiKeys);
  const limiter = new TokenBucketLimiter(now);

  const app = Fastify({
    logger:
      options.logger === false
        ? false
        : {
            level: config.logLevel,
            redact: ['req.headers.authorization', 'req.headers["x-api-key"]'],
          },
    genReqId: (req) => {
      const header = req.headers['x-request-id'];
      return typeof header === 'string' && header.length <= 128 ? header : randomUUID();
    },
    bodyLimit: 4 * 1024 * 1024,
  }).withTypeProvider<ZodTypeProvider>();

  const sink =
    options.usageSink ?? (config.usageLogPath ? jsonlSink(config.usageLogPath) : undefined);
  const usage = new UsageTracker(sink, (error) => {
    app.log.error({ err: error }, 'usage sink failed');
  });

  const gateway = new Gateway({
    providers,
    router,
    cache,
    retry: {
      ...config.retry,
      ...(options.sleep ? { sleep: options.sleep } : {}),
      ...(options.random ? { random: options.random } : {}),
    },
    timeoutMs: config.timeoutMs,
    circuit: config.circuit,
    now,
    onEvent: (event, data) => {
      app.log.warn({ event, ...data }, `provider ${event}`);
    },
  });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.setErrorHandler((error, request, reply) => {
    if (hasZodFastifySchemaValidationErrors(error)) {
      const issues = error.validation as unknown as { instancePath?: string; message?: string }[];
      const message = issues
        .map(
          (v) =>
            `${v.instancePath === undefined || v.instancePath === '' ? '/' : v.instancePath} ${v.message ?? 'is invalid'}`,
        )
        .join('; ');
      return reply.status(400).send({ error: { message, type: 'invalid_request_error' } });
    }
    if (error instanceof GatewayError) {
      return reply
        .status(error.statusCode)
        .send({ error: { message: error.message, type: error.type, details: error.details } });
    }
    const statusCode = (error as { statusCode?: number }).statusCode;
    if (statusCode && statusCode < 500) {
      return reply
        .status(statusCode)
        .send({ error: { message: (error as Error).message, type: 'invalid_request_error' } });
    }
    request.log.error({ err: error }, 'unhandled error');
    return reply.status(500).send({ error: { message: 'internal error', type: 'server_error' } });
  });

  app.setNotFoundHandler((request, reply) =>
    reply.status(404).send({
      error: {
        message: `route ${request.method} ${request.url} not found`,
        type: 'invalid_request_error',
      },
    }),
  );

  await app.register(fastifySwagger, {
    openapi: {
      info: {
        title: 'LLM Gateway',
        description:
          'OpenAI-compatible gateway with provider routing, fallback, retries, caching, rate limiting and usage tracking.',
        version: '0.1.0',
      },
      components: {
        securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } },
      },
      security: [{ bearerAuth: [] }],
    },
    transform: jsonSchemaTransform,
  });
  await app.register(fastifySwaggerUi, { routePrefix: '/docs' });

  // ------------------------------------------------------------------ hooks
  const authenticate = async (request: FastifyRequest): Promise<void> => {
    const record = keys.authenticate(request.headers);
    if (!record) throw new GatewayError(401, 'invalid or missing API key', 'authentication_error');
    request.apiKey = record;
    await Promise.resolve();
  };

  const rateLimit = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const key = request.apiKey;
    if (!key) return;
    const decision = limiter.take(key.name, key.rpm);
    void reply.headers({
      'x-ratelimit-limit': decision.limit,
      'x-ratelimit-remaining': decision.remaining,
      'x-ratelimit-reset': decision.resetSeconds,
    });
    if (!decision.allowed) {
      void reply.header('retry-after', decision.retryAfterSeconds);
      throw new GatewayError(429, `rate limit exceeded for key "${key.name}"`, 'rate_limit_error');
    }
    await Promise.resolve();
  };

  // ------------------------------------------------------------------ routes
  app.get(
    '/health',
    { schema: { tags: ['ops'], security: [], response: { 200: HealthSchema } } },
    () => ({
      status: 'ok' as const,
      uptimeSeconds: Math.round((now() - startedAt) / 1000),
      providers: Object.fromEntries(
        [...providers.keys()].map((name) => [name, { circuit: gateway.breaker(name).state }]),
      ),
      cache: { entries: cache?.size ?? 0, hits: cache?.hits ?? 0, misses: cache?.misses ?? 0 },
    }),
  );

  app.get(
    '/v1/models',
    {
      onRequest: [authenticate],
      schema: { tags: ['models'], response: { 200: ModelsResponseSchema, 401: ErrorSchema } },
    },
    () => ({
      object: 'list' as const,
      data: router.listModels().map((m) => ({
        id: m.id,
        object: 'model' as const,
        owned_by: 'llm-gateway',
        targets: m.targets,
      })),
    }),
  );

  app.get(
    '/v1/usage',
    {
      onRequest: [authenticate],
      schema: { tags: ['usage'], response: { 200: UsageSummarySchema, 401: ErrorSchema } },
    },
    (request) => usage.summary(request.apiKey?.name ?? ''),
  );

  app.post(
    '/v1/chat/completions',
    {
      onRequest: [authenticate, rateLimit],
      schema: {
        tags: ['chat'],
        description:
          'OpenAI-compatible chat completions. Set `stream: true` for Server-Sent Events. ' +
          'Requests with `temperature: 0` are cached unless `Cache-Control: no-cache` is sent.',
        body: ChatCompletionRequestSchema,
        response: {
          200: ChatCompletionResponseSchema,
          400: ErrorSchema,
          401: ErrorSchema,
          429: ErrorSchema,
          502: ErrorSchema,
          503: ErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const started = now();
      const body = request.body;
      const apiKey = request.apiKey?.name ?? 'unknown';
      const gatewayRequest = toGatewayRequest(body);
      const id = `chatcmpl-${request.id}`;
      const created = Math.floor(started / 1000);
      const promptEstimate = estimateTokens(body.messages.map((m) => m.content).join(' '));
      const base = {
        timestamp: new Date(started).toISOString(),
        requestId: request.id,
        apiKey,
        requestedModel: body.model,
      };

      const controller = new AbortController();
      reply.raw.on('close', () => {
        if (!reply.raw.writableFinished) controller.abort(new Error('client disconnected'));
      });

      try {
        if (!body.stream) {
          const useCache = request.headers['cache-control'] !== 'no-cache';
          const outcome = await gateway.complete(gatewayRequest, {
            signal: controller.signal,
            useCache,
          });
          usage.record({
            ...base,
            provider: outcome.target.provider,
            model: outcome.target.model,
            stream: false,
            cached: outcome.cached,
            status: 'ok',
            attempts: outcome.attempts.length,
            latencyMs: now() - started,
            usage: outcome.result.usage,
          });
          void reply.headers({
            'x-gateway-provider': outcome.target.provider,
            'x-gateway-model': outcome.target.model,
            'x-gateway-attempts': outcome.attempts.length,
            'x-cache': outcome.cached ? 'HIT' : 'MISS',
          });
          return {
            id,
            object: 'chat.completion' as const,
            created,
            model: `${outcome.target.provider}/${outcome.target.model}`,
            choices: [
              {
                index: 0,
                message: { role: 'assistant' as const, content: outcome.result.content },
                finish_reason: outcome.result.finishReason,
              },
            ],
            usage: openAIUsage(outcome.result.usage),
            gateway: {
              provider: outcome.target.provider,
              cached: outcome.cached,
              attempts: outcome.attempts.length,
            },
          };
        }

        // Streaming: resolve provider + first chunk *before* committing to a 200 response,
        // so routing/fallback failures still produce a proper JSON error.
        const outcome = await gateway.stream(gatewayRequest, { signal: controller.signal });
        const model = `${outcome.target.provider}/${outcome.target.model}`;
        reply.hijack();
        reply.raw.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
          'x-request-id': request.id,
          'x-gateway-provider': outcome.target.provider,
          'x-gateway-model': outcome.target.model,
          'x-gateway-attempts': String(outcome.attempts.length),
          ...Object.fromEntries(
            Object.entries(reply.getHeaders()).filter(([k]) => k.startsWith('x-ratelimit')),
          ),
        });
        const send = (payload: unknown) => reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
        let text = '';
        let finalUsage: Usage | undefined;
        let finishReason = 'stop';
        let status: 'ok' | 'error' = 'ok';
        let streamError: string | undefined;
        try {
          for await (const chunk of outcome.chunks) {
            if (chunk.usage) finalUsage = chunk.usage;
            if (chunk.finishReason) finishReason = chunk.finishReason;
            if (chunk.delta) {
              text += chunk.delta;
              send({
                id,
                object: 'chat.completion.chunk',
                created,
                model,
                choices: [{ index: 0, delta: { content: chunk.delta }, finish_reason: null }],
              });
            }
          }
          const usageOut = finalUsage ?? makeUsage(promptEstimate, estimateTokens(text));
          finalUsage = usageOut;
          send({
            id,
            object: 'chat.completion.chunk',
            created,
            model,
            choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
            usage: openAIUsage(usageOut),
          });
          reply.raw.write('data: [DONE]\n\n');
        } catch (error) {
          status = 'error';
          streamError = error instanceof Error ? error.message : String(error);
          if (!controller.signal.aborted) {
            send({
              error: { message: `stream interrupted: ${streamError}`, type: 'upstream_error' },
            });
          }
        } finally {
          reply.raw.end();
          usage.record({
            ...base,
            provider: outcome.target.provider,
            model: outcome.target.model,
            stream: true,
            cached: false,
            status,
            attempts: outcome.attempts.length,
            latencyMs: now() - started,
            usage: finalUsage ?? makeUsage(promptEstimate, estimateTokens(text)),
            ...(streamError ? { error: streamError } : {}),
          });
        }
        return undefined; // response already written to the hijacked socket
      } catch (error) {
        usage.record({
          ...base,
          stream: body.stream,
          cached: false,
          status: 'error',
          attempts: 0,
          latencyMs: now() - started,
          usage: makeUsage(0, 0),
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    },
  );

  return app;
}
