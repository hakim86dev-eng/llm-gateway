import type { GatewayConfig } from '../src/config.js';
import type { FetchFn } from '../src/types.js';

export interface RecordedCall {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

export type Handler = (call: RecordedCall, index: number) => Response | Promise<Response>;

/** A `fetch` double that routes by URL and records every call. */
export function fakeFetch(handler: Handler): FetchFn & { calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fn = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const raw = typeof init?.body === 'string' ? init.body : '';
    const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    init?.signal?.throwIfAborted();
    const call = { url, headers, body };
    calls.push(call);
    return handler(call, calls.length - 1);
  };
  return Object.assign(fn, { calls });
}

export const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

export function streamResponse(parts: string[], contentType = 'text/event-stream'): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of parts) controller.enqueue(encoder.encode(part));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': contentType } });
}

export const openAIResponse = (content: string, prompt = 5, completion = 3) =>
  json(200, {
    choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: prompt, completion_tokens: completion },
  });

export const anthropicResponse = (text: string) =>
  json(200, {
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 7, output_tokens: 2 },
  });

export function testConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    port: 0,
    host: '127.0.0.1',
    logLevel: 'silent',
    apiKeys: [
      { name: 'team-a', key: 'sk-gw-team-a-123', rpm: 100 },
      { name: 'team-b', key: 'sk-gw-team-b-456', rpm: 2 },
    ],
    openai: { apiKey: 'sk-openai-test', baseUrl: 'https://openai.test/v1' },
    anthropic: { apiKey: 'sk-ant-test', baseUrl: 'https://anthropic.test' },
    ollama: { baseUrl: 'http://ollama.test:11434' },
    enableMock: true,
    timeoutMs: 1_000,
    retry: { retries: 2, baseDelayMs: 1, maxDelayMs: 5 },
    cache: { ttlMs: 60_000, maxEntries: 100 },
    circuit: { failureThreshold: 3, cooldownMs: 10_000 },
    routes: {
      fast: ['openai/gpt-4o-mini', 'anthropic/claude-3-5-haiku-latest'],
      local: ['ollama/llama3.1'],
      demo: ['mock/echo'],
    },
    ...overrides,
  };
}

export const AUTH = { authorization: 'Bearer sk-gw-team-a-123' };
export const noSleep = (): Promise<void> => Promise.resolve();
