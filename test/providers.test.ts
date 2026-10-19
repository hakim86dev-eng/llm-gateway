import { describe, expect, it } from 'vitest';
import { ProviderError } from '../src/errors.js';
import {
  AnthropicProvider,
  MockProvider,
  OllamaProvider,
  OpenAIProvider,
} from '../src/providers/index.js';
import type { ChatRequest, StreamChunk } from '../src/types.js';
import { anthropicResponse, fakeFetch, json, openAIResponse, streamResponse } from './helpers.js';

const request: ChatRequest = {
  model: 'm',
  messages: [
    { role: 'system', content: 'Be brief.' },
    { role: 'user', content: 'Hello' },
  ],
  temperature: 0,
  maxTokens: 64,
};

async function collect(iterable: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = [];
  for await (const chunk of iterable) out.push(chunk);
  return out;
}

describe('OpenAIProvider', () => {
  it('maps the request and parses the response', async () => {
    const fetch = fakeFetch(() => openAIResponse('Hi!', 9, 2));
    const provider = new OpenAIProvider({
      apiKey: 'sk-x',
      baseUrl: 'https://openai.test/v1/',
      fetch,
    });
    const result = await provider.chat(request);
    expect(result).toEqual({
      content: 'Hi!',
      finishReason: 'stop',
      usage: { promptTokens: 9, completionTokens: 2, totalTokens: 11 },
    });
    const [call] = fetch.calls;
    expect(call?.url).toBe('https://openai.test/v1/chat/completions');
    expect(call?.headers.authorization).toBe('Bearer sk-x');
    expect(call?.body).toMatchObject({ model: 'm', max_tokens: 64, temperature: 0, stream: false });
  });

  it('streams deltas and the final usage chunk', async () => {
    const fetch = fakeFetch(() =>
      streamResponse([
        'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"lo"},"finish_reason":"stop"}]}\n\n',
        'data: {"choices":[],"usage":{"prompt_tokens":4,"completion_tokens":2}}\n\n',
        'data: [DONE]\n\n',
      ]),
    );
    const chunks = await collect(new OpenAIProvider({ apiKey: 'k', fetch }).stream(request));
    expect(chunks.map((c) => c.delta).join('')).toBe('Hello');
    expect(chunks.at(-1)?.usage?.totalTokens).toBe(6);
    expect(fetch.calls[0]?.body).toMatchObject({
      stream: true,
      stream_options: { include_usage: true },
    });
  });

  it('classifies HTTP errors for retry/fallback', async () => {
    const limited = new OpenAIProvider({
      apiKey: 'k',
      fetch: fakeFetch(() => json(429, {}, { 'retry-after': '3' })),
    });
    const error = await limited.chat(request).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({
      status: 429,
      retryable: true,
      retryAfterMs: 3000,
      fallbackable: true,
    });

    const bad = new OpenAIProvider({
      apiKey: 'k',
      fetch: fakeFetch(() => json(400, { error: 'bad' })),
    });
    await expect(bad.chat(request)).rejects.toMatchObject({
      status: 400,
      retryable: false,
      fallbackable: false,
    });

    const unauthorised = new OpenAIProvider({ apiKey: 'k', fetch: fakeFetch(() => json(401, {})) });
    await expect(unauthorised.chat(request)).rejects.toMatchObject({
      retryable: false,
      fallbackable: true,
    });

    const network = new OpenAIProvider({
      apiKey: 'k',
      fetch: () => Promise.reject(new TypeError('fetch failed')),
    });
    await expect(network.chat(request)).rejects.toMatchObject({
      retryable: true,
      status: undefined,
    });
  });
});

describe('AnthropicProvider', () => {
  it('moves system messages to the top-level system field', async () => {
    const fetch = fakeFetch(() => anthropicResponse('Hey'));
    const provider = new AnthropicProvider({
      apiKey: 'ant',
      baseUrl: 'https://anthropic.test',
      fetch,
    });
    const result = await provider.chat(request);
    expect(result.content).toBe('Hey');
    expect(result.usage.totalTokens).toBe(9);
    const [call] = fetch.calls;
    expect(call?.url).toBe('https://anthropic.test/v1/messages');
    expect(call?.headers['x-api-key']).toBe('ant');
    expect(call?.headers['anthropic-version']).toBe('2023-06-01');
    expect(call?.body).toMatchObject({
      system: 'Be brief.',
      max_tokens: 64,
      messages: [{ role: 'user', content: 'Hello' }],
    });
  });

  it('defaults max_tokens (required by the API) and maps stop reasons', async () => {
    const fetch = fakeFetch(() =>
      json(200, {
        content: [{ type: 'text', text: 'x' }],
        stop_reason: 'max_tokens',
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    );
    const provider = new AnthropicProvider({ apiKey: 'a', fetch, defaultMaxTokens: 256 });
    const result = await provider.chat({ model: 'c', messages: [{ role: 'user', content: 'q' }] });
    expect(result.finishReason).toBe('length');
    expect(fetch.calls[0]?.body.max_tokens).toBe(256);
    expect(fetch.calls[0]?.body).not.toHaveProperty('system');
  });

  it('parses the event stream', async () => {
    const fetch = fakeFetch(() =>
      streamResponse([
        'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":5}}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hi"}}\n\n',
        'event: ping\ndata: {"type":"ping"}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ]),
    );
    const chunks = await collect(new AnthropicProvider({ apiKey: 'a', fetch }).stream(request));
    expect(chunks).toEqual([
      { delta: 'Hi' },
      {
        delta: '',
        finishReason: 'stop',
        usage: { promptTokens: 5, completionTokens: 1, totalTokens: 6 },
      },
    ]);
  });

  it('surfaces stream error events', async () => {
    const fetch = fakeFetch(() =>
      streamResponse([
        'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n',
      ]),
    );
    await expect(
      collect(new AnthropicProvider({ apiKey: 'a', fetch }).stream(request)),
    ).rejects.toMatchObject({
      retryable: true,
    });
  });
});

describe('OllamaProvider', () => {
  it('calls /api/chat and maps options', async () => {
    const fetch = fakeFetch(() =>
      json(200, {
        message: { content: 'local' },
        done: true,
        done_reason: 'stop',
        prompt_eval_count: 3,
        eval_count: 1,
      }),
    );
    const result = await new OllamaProvider({ baseUrl: 'http://ollama.test:11434', fetch }).chat(
      request,
    );
    expect(result).toMatchObject({ content: 'local', usage: { totalTokens: 4 } });
    expect(fetch.calls[0]?.url).toBe('http://ollama.test:11434/api/chat');
    expect(fetch.calls[0]?.body).toMatchObject({
      stream: false,
      options: { num_predict: 64, temperature: 0 },
    });
  });

  it('streams NDJSON', async () => {
    const fetch = fakeFetch(() =>
      streamResponse(
        [
          '{"message":{"content":"a"},"done":false}\n{"message":{"content":"b"},"done":false}\n',
          '{"message":{"content":""},"done":true,"done_reason":"stop","prompt_eval_count":2,"eval_count":2}\n',
        ],
        'application/x-ndjson',
      ),
    );
    const chunks = await collect(new OllamaProvider({ fetch }).stream(request));
    expect(chunks.map((c) => c.delta).join('')).toBe('ab');
    expect(chunks.at(-1)?.usage?.totalTokens).toBe(4);
  });

  it('turns error payloads into ProviderErrors', async () => {
    const fetch = fakeFetch(() => json(200, { error: 'model not found' }));
    await expect(new OllamaProvider({ fetch }).chat(request)).rejects.toThrow('model not found');
  });
});

describe('MockProvider', () => {
  it('echoes the last user message, streaming word by word', async () => {
    const provider = new MockProvider();
    expect((await provider.chat(request)).content).toBe('Echo from m: Hello');
    const chunks = await collect(provider.stream(request));
    expect(chunks.map((c) => c.delta).join('')).toBe('Echo from m: Hello');
    expect(chunks.at(-1)?.finishReason).toBe('stop');
  });
});
