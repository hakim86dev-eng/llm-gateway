import { describe, expect, it } from 'vitest';
import { ApiKeyStore } from '../src/core/auth.js';
import { ModelRouter } from '../src/core/router.js';
import { DEFAULT_ROUTES, loadConfig, parseApiKeys } from '../src/config.js';

describe('loadConfig', () => {
  it('applies defaults and only enables configured providers', () => {
    const config = loadConfig({
      GATEWAY_API_KEYS: 'demo:sk-gw-demo-123',
      OPENAI_API_KEY: 'sk',
      ANTHROPIC_API_KEY: '',
    });
    expect(config.port).toBe(8080);
    expect(config.openai?.apiKey).toBe('sk');
    expect(config.anthropic).toBeUndefined(); // empty string = unset
    expect(config.ollama).toBeUndefined();
    expect(config.enableMock).toBe(false);
    expect(config.routes).toEqual(DEFAULT_ROUTES);
    expect(config.apiKeys).toEqual([{ name: 'demo', key: 'sk-gw-demo-123', rpm: 60 }]);
  });

  it('parses custom routes and booleans', () => {
    const config = loadConfig({
      GATEWAY_API_KEYS: 'a:12345678',
      ENABLE_MOCK_PROVIDER: 'true',
      MODEL_ROUTES: JSON.stringify({ cheap: ['ollama/qwen2.5', 'mock/echo'] }),
      CACHE_TTL_SECONDS: '0',
    });
    expect(config.enableMock).toBe(true);
    expect(config.routes).toEqual({ cheap: ['ollama/qwen2.5', 'mock/echo'] });
    expect(config.cache.ttlMs).toBe(0);
  });

  it('rejects invalid configuration with a readable message', () => {
    expect(() => loadConfig({})).toThrow(/GATEWAY_API_KEYS/);
    expect(() => loadConfig({ GATEWAY_API_KEYS: 'a:12345678', PORT: 'abc' })).toThrow(/PORT/);
    expect(() =>
      loadConfig({ GATEWAY_API_KEYS: 'a:12345678', MODEL_ROUTES: '{"x":["nope"]}' }),
    ).toThrow();
  });
});

describe('parseApiKeys', () => {
  it('supports per-key rpm and validates entries', () => {
    expect(parseApiKeys('a:key-aaaa1:10, b:key-bbbb2', 60)).toEqual([
      { name: 'a', key: 'key-aaaa1', rpm: 10 },
      { name: 'b', key: 'key-bbbb2', rpm: 60 },
    ]);
    expect(() => parseApiKeys('a:short', 60)).toThrow(/8 chars/);
    expect(() => parseApiKeys('a:key-aaaa1:zero', 60)).toThrow(/rpm/);
    expect(() => parseApiKeys('a:key-aaaa1,a:key-bbbb2', 60)).toThrow(/unique/);
    expect(() => parseApiKeys(' , ', 60)).toThrow(/at least one/);
  });
});

describe('ApiKeyStore', () => {
  const store = new ApiKeyStore([{ name: 'team', key: 'sk-gw-secret-1', rpm: 5 }]);
  it('accepts Bearer and x-api-key headers', () => {
    expect(store.authenticate({ authorization: 'Bearer sk-gw-secret-1' })).toEqual({
      name: 'team',
      rpm: 5,
    });
    expect(store.authenticate({ 'x-api-key': 'sk-gw-secret-1' })?.name).toBe('team');
  });
  it('rejects missing or wrong keys', () => {
    expect(store.authenticate({})).toBeUndefined();
    expect(store.authenticate({ authorization: 'Bearer nope' })).toBeUndefined();
    expect(store.authenticate({ authorization: 'Basic sk-gw-secret-1' })).toBeUndefined();
  });
});

describe('ModelRouter', () => {
  const router = new ModelRouter(
    { fast: ['openai/gpt-4o-mini', 'anthropic/claude-3-5-haiku-latest', 'ollama/llama3.1'] },
    new Set(['openai', 'ollama'] as const),
  );

  it('expands aliases into a fallback chain of configured providers', () => {
    expect(router.resolve('fast')).toEqual([
      { provider: 'openai', model: 'gpt-4o-mini' },
      { provider: 'ollama', model: 'llama3.1' },
    ]);
  });

  it('supports explicit provider/model (including nested names) and inference', () => {
    expect(router.resolve('ollama/library/llama3.1')).toEqual([
      { provider: 'ollama', model: 'library/llama3.1' },
    ]);
    expect(router.resolve('gpt-4o')).toEqual([{ provider: 'openai', model: 'gpt-4o' }]);
  });

  it('rejects unknown models and unconfigured providers', () => {
    expect(() => router.resolve('llama-from-nowhere')).toThrow(/unknown model/);
    expect(() => router.resolve('claude-sonnet-4-5')).toThrow(/not configured \(anthropic\)/);
  });

  it('lists aliases with their available targets', () => {
    expect(router.listModels()).toEqual([
      { id: 'fast', targets: ['openai/gpt-4o-mini', 'ollama/llama3.1'] },
    ]);
  });
});
