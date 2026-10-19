import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { UsageEvent } from '../src/core/usage.js';
import { buildApp, type AppOptions } from '../src/http/app.js';
import {
  AUTH,
  anthropicResponse,
  fakeFetch,
  json,
  noSleep,
  openAIResponse,
  streamResponse,
  testConfig,
  type Handler,
} from './helpers.js';

const chat = (overrides: Record<string, unknown> = {}) => ({
  model: 'fast',
  messages: [{ role: 'user', content: 'What is RAG?' }],
  temperature: 0,
  ...overrides,
});

let app: FastifyInstance | undefined;

async function setup(handler: Handler, options: Partial<AppOptions> = {}) {
  const fetch = fakeFetch(handler);
  const events: UsageEvent[] = [];
  app = await buildApp({
    config: testConfig(),
    fetch,
    sleep: noSleep,
    random: () => 0,
    logger: false,
    usageSink: (e) => {
      events.push(e);
      return Promise.resolve();
    },
    ...options,
  });
  return { app, fetch, events };
}

afterEach(async () => {
  await app?.close();
  app = undefined;
});

const isOpenAI = (url: string) => url.startsWith('https://openai.test');

describe('auth & validation', () => {
  it('rejects missing or invalid keys before validating the body', async () => {
    const { app } = await setup(() => openAIResponse('x'));
    const missing = await app.inject({ method: 'POST', url: '/v1/chat/completions', payload: {} });
    expect(missing.statusCode).toBe(401);
    expect(missing.json()).toEqual({
      error: { message: 'invalid or missing API key', type: 'authentication_error' },
    });
    const wrong = await app.inject({
      method: 'GET',
      url: '/v1/models',
      headers: { 'x-api-key': 'nope' },
    });
    expect(wrong.statusCode).toBe(401);
  });

  it('returns OpenAI-style 400s for invalid bodies and unknown models', async () => {
    const { app } = await setup(() => openAIResponse('x'));
    const invalid = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: AUTH,
      payload: chat({ messages: [], temperature: 5 }),
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json<{ error: { type: string } }>().error.type).toBe('invalid_request_error');
    const unknown = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: AUTH,
      payload: chat({ model: 'mystery-model' }),
    });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.body).toContain('unknown model');
  });

  it('returns 404 in the same error format', async () => {
    const { app } = await setup(() => openAIResponse('x'));
    const res = await app.inject({ method: 'GET', url: '/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json<{ error: { type: string } }>().error.type).toBe('invalid_request_error');
  });
});

describe('chat completions', () => {
  it('routes an alias to the first provider and returns an OpenAI-compatible body', async () => {
    const { app, fetch, events } = await setup(() =>
      openAIResponse('Retrieval-augmented generation.', 6, 4),
    );
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: AUTH,
      payload: chat(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-gateway-provider']).toBe('openai');
    expect(res.headers['x-cache']).toBe('MISS');
    expect(res.headers['x-ratelimit-limit']).toBe('100');
    const body = res.json<Record<string, unknown>>();
    expect(body).toMatchObject({
      object: 'chat.completion',
      model: 'openai/gpt-4o-mini',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'Retrieval-augmented generation.' },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 6, completion_tokens: 4, total_tokens: 10 },
      gateway: { provider: 'openai', cached: false, attempts: 1 },
    });
    expect(fetch.calls[0]?.body.model).toBe('gpt-4o-mini');
    expect(events[0]).toMatchObject({
      apiKey: 'team-a',
      provider: 'openai',
      status: 'ok',
      cached: false,
    });
  });

  it('retries transient errors on the same provider', async () => {
    const { app, fetch } = await setup((_call, i) =>
      i < 2 ? json(503, {}) : openAIResponse('ok'),
    );
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: AUTH,
      payload: chat(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-gateway-provider']).toBe('openai');
    expect(res.headers['x-gateway-attempts']).toBe('3');
    expect(fetch.calls).toHaveLength(3);
  });

  it('falls back to the next provider when one keeps failing', async () => {
    const { app, fetch } = await setup((call) =>
      isOpenAI(call.url) ? json(500, { error: 'down' }) : anthropicResponse('from claude'),
    );
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: AUTH,
      payload: chat(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-gateway-provider']).toBe('anthropic');
    expect(res.headers['x-gateway-attempts']).toBe('4'); // 3 openai attempts + 1 anthropic
    expect(
      res.json<{ choices: { message: { content: string } }[] }>().choices[0]?.message.content,
    ).toBe('from claude');
    expect(fetch.calls.filter((c) => isOpenAI(c.url))).toHaveLength(3);
  });

  it('falls back immediately on auth errors from a provider, without retrying', async () => {
    const { app, fetch } = await setup((call) =>
      isOpenAI(call.url) ? json(401, {}) : anthropicResponse('ok'),
    );
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: AUTH,
      payload: chat(),
    });
    expect(res.headers['x-gateway-provider']).toBe('anthropic');
    expect(fetch.calls.filter((c) => isOpenAI(c.url))).toHaveLength(1);
  });

  it('does not fall back on client errors (400) and surfaces them', async () => {
    const { app, fetch } = await setup(() => json(400, { error: { message: 'context too long' } }));
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: AUTH,
      payload: chat(),
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('context too long');
    expect(fetch.calls).toHaveLength(1);
  });

  it('returns 502 with attempt details when every provider fails', async () => {
    const { app, events } = await setup(() => json(503, {}));
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: AUTH,
      payload: chat(),
    });
    expect(res.statusCode).toBe(502);
    const body = res.json<{ error: { type: string; details: { attempts: unknown[] } } }>();
    expect(body.error.type).toBe('upstream_error');
    expect(body.error.details.attempts).toHaveLength(6);
    expect(events.at(-1)).toMatchObject({ status: 'error' });
  });

  it('opens the circuit for a failing provider so later requests skip it', async () => {
    const { app, fetch } = await setup((call) =>
      isOpenAI(call.url) ? json(500, {}) : anthropicResponse('ok'),
    );
    for (let i = 0; i < 3; i++) {
      await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: AUTH,
        payload: chat({ temperature: 0.5 }),
      });
    }
    const openaiCallsBefore = fetch.calls.filter((c) => isOpenAI(c.url)).length;
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: AUTH,
      payload: chat({ temperature: 0.5 }),
    });
    expect(res.headers['x-gateway-provider']).toBe('anthropic');
    expect(fetch.calls.filter((c) => isOpenAI(c.url)).length).toBe(openaiCallsBefore);
    const health = await app.inject({ method: 'GET', url: '/health' });
    expect(
      health.json<{ providers: Record<string, { circuit: string }> }>().providers.openai?.circuit,
    ).toBe('open');
  });

  it('times out slow providers and falls back', async () => {
    const { app } = await setup(
      (call) =>
        isOpenAI(call.url)
          ? new Promise<Response>(() => undefined) // never resolves
          : anthropicResponse('fast enough'),
      {
        config: {
          ...testConfig(),
          timeoutMs: 20,
          retry: { retries: 0, baseDelayMs: 0, maxDelayMs: 0 },
        },
      },
    );
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: AUTH,
      payload: chat(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-gateway-provider']).toBe('anthropic');
  });
});

describe('caching', () => {
  it('serves identical temperature-0 requests from cache', async () => {
    const { app, fetch, events } = await setup(() => openAIResponse('cached answer'));
    const first = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: AUTH,
      payload: chat(),
    });
    const second = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: AUTH,
      payload: chat(),
    });
    expect(first.headers['x-cache']).toBe('MISS');
    expect(second.headers['x-cache']).toBe('HIT');
    expect(second.json<{ gateway: { cached: boolean } }>().gateway.cached).toBe(true);
    expect(fetch.calls).toHaveLength(1);
    expect(events.map((e) => e.cached)).toEqual([false, true]);
  });

  it('skips the cache for non-zero temperature or Cache-Control: no-cache', async () => {
    const { app, fetch } = await setup(() => openAIResponse('fresh'));
    await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: AUTH,
      payload: chat({ temperature: 0.7 }),
    });
    await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: AUTH,
      payload: chat({ temperature: 0.7 }),
    });
    await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: AUTH,
      payload: chat(),
    });
    await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { ...AUTH, 'cache-control': 'no-cache' },
      payload: chat(),
    });
    expect(fetch.calls).toHaveLength(4);
  });
});

describe('rate limiting', () => {
  it('enforces per-key limits with Retry-After', async () => {
    const { app } = await setup(() => openAIResponse('ok'));
    const teamB = { authorization: 'Bearer sk-gw-team-b-456' }; // 2 rpm
    const statuses: number[] = [];
    let last;
    for (let i = 0; i < 3; i++) {
      last = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: teamB,
        payload: chat({ temperature: 1 }),
      });
      statuses.push(last.statusCode);
    }
    expect(statuses).toEqual([200, 200, 429]);
    expect(last?.headers['retry-after']).toBe('30');
    expect(last?.json<{ error: { type: string } }>().error.type).toBe('rate_limit_error');
    // Other keys are unaffected.
    const teamA = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: AUTH,
      payload: chat(),
    });
    expect(teamA.statusCode).toBe(200);
  });
});

function parseSse(body: string): unknown[] {
  return body
    .trim()
    .split('\n\n')
    .map((block) => block.replace(/^data: /, ''))
    .map((data) => (data === '[DONE]' ? data : (JSON.parse(data) as unknown)));
}

describe('streaming (SSE)', () => {
  it('streams OpenAI-compatible chunks and terminates with [DONE]', async () => {
    const { app, events } = await setup(() =>
      streamResponse([
        'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"lo"},"finish_reason":"stop"}]}\n\n',
        'data: {"choices":[],"usage":{"prompt_tokens":4,"completion_tokens":2}}\n\n',
        'data: [DONE]\n\n',
      ]),
    );
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: AUTH,
      payload: chat({ stream: true }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(res.headers['x-gateway-provider']).toBe('openai');
    const events_ = parseSse(res.body);
    expect(events_.at(-1)).toBe('[DONE]');
    const chunks = events_.slice(0, -1) as {
      choices: { delta: { content?: string }; finish_reason: string | null }[];
      usage?: { total_tokens: number };
    }[];
    expect(chunks.map((c) => c.choices[0]?.delta.content ?? '').join('')).toBe('Hello');
    expect(chunks.at(-1)?.choices[0]?.finish_reason).toBe('stop');
    expect(chunks.at(-1)?.usage?.total_tokens).toBe(6);
    expect(events.at(-1)).toMatchObject({ stream: true, status: 'ok', usage: { totalTokens: 6 } });
  });

  it('falls back before the first token if the primary stream fails', async () => {
    const { app } = await setup((call) =>
      isOpenAI(call.url)
        ? json(503, {})
        : streamResponse([
            'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"claude"}}\n\n',
            'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n',
          ]),
    );
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: AUTH,
      payload: chat({ stream: true }),
    });
    expect(res.headers['x-gateway-provider']).toBe('anthropic');
    expect(res.body).toContain('"content":"claude"');
    expect(res.body.trim().endsWith('data: [DONE]')).toBe(true);
  });

  it('reports a mid-stream failure as an SSE error event', async () => {
    const encoder = new TextEncoder();
    const { app, events } = await setup(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                encoder.encode('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'),
              );
            },
            pull(controller) {
              // Fails on the read *after* the first chunk was delivered.
              controller.error(new Error('connection reset'));
            },
          }),
          { status: 200 },
        ),
    );
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: AUTH,
      payload: chat({ stream: true, model: 'gpt-4o-mini' }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('"content":"partial"');
    expect(res.body).toContain('stream interrupted');
    expect(res.body).not.toContain('[DONE]');
    expect(events.at(-1)).toMatchObject({ status: 'error', stream: true });
  });

  it('returns a JSON error (not a broken stream) when no provider can start', async () => {
    const { app } = await setup(() => json(503, {}));
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: AUTH,
      payload: chat({ stream: true }),
    });
    expect(res.statusCode).toBe(502);
    expect(res.headers['content-type']).toContain('application/json');
  });
});

describe('models, usage, health & docs', () => {
  it('lists available aliases', async () => {
    const { app } = await setup(() => openAIResponse('x'));
    const res = await app.inject({ method: 'GET', url: '/v1/models', headers: AUTH });
    const ids = res.json<{ data: { id: string; targets: string[] }[] }>().data.map((m) => m.id);
    expect(ids).toEqual(['fast', 'local', 'demo']);
  });

  it('aggregates usage per API key (cached tokens are not billed)', async () => {
    const { app } = await setup(() => openAIResponse('x', 10, 5));
    await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: AUTH,
      payload: chat(),
    });
    await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: AUTH,
      payload: chat(),
    });
    await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: AUTH,
      payload: chat({ model: 'demo' }),
    });
    const usage = await app.inject({ method: 'GET', url: '/v1/usage', headers: AUTH });
    expect(usage.json()).toMatchObject({
      apiKey: 'team-a',
      requests: 3,
      cachedRequests: 1,
      promptTokens: 10 + 3,
      byModel: {
        'openai/gpt-4o-mini': { requests: 2, totalTokens: 15 },
        'mock/echo': { requests: 1 },
      },
    });
    const other = await app.inject({
      method: 'GET',
      url: '/v1/usage',
      headers: { 'x-api-key': 'sk-gw-team-b-456' },
    });
    expect(other.json<{ requests: number }>().requests).toBe(0);
  });

  it('serves health without auth and an OpenAPI document', async () => {
    const { app } = await setup(() => openAIResponse('x'));
    const health = await app.inject({ method: 'GET', url: '/health' });
    expect(health.json()).toMatchObject({
      status: 'ok',
      providers: { openai: { circuit: 'closed' }, mock: { circuit: 'closed' } },
    });
    const spec = await app.inject({ method: 'GET', url: '/docs/json' });
    const doc = spec.json<{ openapi: string; paths: Record<string, unknown> }>();
    expect(doc.openapi).toMatch(/^3\./);
    expect(Object.keys(doc.paths)).toEqual(
      expect.arrayContaining(['/v1/chat/completions', '/v1/models', '/v1/usage', '/health']),
    );
    const ui = await app.inject({ method: 'GET', url: '/docs' });
    expect([200, 302]).toContain(ui.statusCode);
  });

  it('propagates x-request-id', async () => {
    const { app, events } = await setup(() => openAIResponse('x'));
    await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { ...AUTH, 'x-request-id': 'req-123' },
      payload: chat(),
    });
    expect(events[0]?.requestId).toBe('req-123');
  });
});
