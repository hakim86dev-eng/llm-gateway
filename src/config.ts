import { z } from 'zod';
import { PROVIDER_NAMES } from './types.js';

/** Treat empty strings (e.g. `OPENAI_API_KEY=` in .env) as "not set". */
const optionalString = z.preprocess((v) => (v === '' ? undefined : v), z.string().optional());
const optionalUrl = z.preprocess((v) => (v === '' ? undefined : v), z.url().optional());
const bool = z.preprocess(
  (v) => (typeof v === 'string' ? ['1', 'true', 'yes', 'on'].includes(v.toLowerCase()) : v),
  z.boolean(),
);
const int = (def: number, min = 0) => z.coerce.number().int().min(min).default(def);

const routesSchema = z.record(
  z.string().min(1),
  z
    .array(
      z.string().regex(new RegExp(`^(${PROVIDER_NAMES.join('|')})/.+`), 'expected provider/model'),
    )
    .min(1),
);

export const DEFAULT_ROUTES: Record<string, string[]> = {
  fast: ['openai/gpt-4o-mini', 'anthropic/claude-3-5-haiku-latest', 'ollama/llama3.1', 'mock/echo'],
  smart: ['openai/gpt-4o', 'anthropic/claude-sonnet-4-5', 'mock/echo'],
  local: ['ollama/llama3.1', 'mock/echo'],
  demo: ['mock/echo'],
};

const envSchema = z.object({
  PORT: int(8080, 1),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  GATEWAY_API_KEYS: z
    .string({ error: 'GATEWAY_API_KEYS is required' })
    .min(1, 'GATEWAY_API_KEYS is required'),
  DEFAULT_RPM: int(60, 1),
  OPENAI_API_KEY: optionalString,
  OPENAI_BASE_URL: z.url().default('https://api.openai.com/v1'),
  ANTHROPIC_API_KEY: optionalString,
  ANTHROPIC_BASE_URL: z.url().default('https://api.anthropic.com'),
  OLLAMA_BASE_URL: optionalUrl,
  ENABLE_MOCK_PROVIDER: bool.default(false),
  REQUEST_TIMEOUT_MS: int(30_000, 1),
  MAX_RETRIES: int(2),
  RETRY_BASE_DELAY_MS: int(250),
  RETRY_MAX_DELAY_MS: int(4_000),
  CACHE_TTL_SECONDS: int(300),
  CACHE_MAX_ENTRIES: int(1_000, 1),
  CIRCUIT_FAILURE_THRESHOLD: int(5, 1),
  CIRCUIT_COOLDOWN_MS: int(30_000),
  MODEL_ROUTES: optionalString,
  USAGE_LOG_PATH: optionalString,
});

export interface ApiKeyConfig {
  name: string;
  key: string;
  rpm: number;
}

export interface GatewayConfig {
  port: number;
  host: string;
  logLevel: z.infer<typeof envSchema>['LOG_LEVEL'];
  apiKeys: ApiKeyConfig[];
  openai?: { apiKey: string; baseUrl: string };
  anthropic?: { apiKey: string; baseUrl: string };
  ollama?: { baseUrl: string };
  enableMock: boolean;
  timeoutMs: number;
  retry: { retries: number; baseDelayMs: number; maxDelayMs: number };
  cache: { ttlMs: number; maxEntries: number };
  circuit: { failureThreshold: number; cooldownMs: number };
  routes: Record<string, string[]>;
  usageLogPath?: string;
}

/** Parse `name:key[:rpm]` entries separated by commas. */
export function parseApiKeys(raw: string, defaultRpm: number): ApiKeyConfig[] {
  const entries = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const [name, key, rpm] = entry.split(':');
      if (!name || !key || key.length < 8) {
        throw new Error(
          `invalid GATEWAY_API_KEYS entry "${name ?? ''}": use name:key[:rpm], key >= 8 chars`,
        );
      }
      const limit = rpm === undefined ? defaultRpm : Number(rpm);
      if (!Number.isInteger(limit) || limit <= 0) throw new Error(`invalid rpm for key "${name}"`);
      return { name, key, rpm: limit };
    });
  const names = new Set(entries.map((e) => e.name));
  if (names.size !== entries.length) throw new Error('GATEWAY_API_KEYS names must be unique');
  if (entries.length === 0) throw new Error('GATEWAY_API_KEYS must contain at least one key');
  return entries;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`invalid configuration: ${issues}`);
  }
  const e = result.data;
  const routes = e.MODEL_ROUTES ? routesSchema.parse(JSON.parse(e.MODEL_ROUTES)) : DEFAULT_ROUTES;
  return {
    port: e.PORT,
    host: e.HOST,
    logLevel: e.LOG_LEVEL,
    apiKeys: parseApiKeys(e.GATEWAY_API_KEYS, e.DEFAULT_RPM),
    ...(e.OPENAI_API_KEY
      ? { openai: { apiKey: e.OPENAI_API_KEY, baseUrl: e.OPENAI_BASE_URL } }
      : {}),
    ...(e.ANTHROPIC_API_KEY
      ? { anthropic: { apiKey: e.ANTHROPIC_API_KEY, baseUrl: e.ANTHROPIC_BASE_URL } }
      : {}),
    ...(e.OLLAMA_BASE_URL ? { ollama: { baseUrl: e.OLLAMA_BASE_URL } } : {}),
    enableMock: e.ENABLE_MOCK_PROVIDER,
    timeoutMs: e.REQUEST_TIMEOUT_MS,
    retry: {
      retries: e.MAX_RETRIES,
      baseDelayMs: e.RETRY_BASE_DELAY_MS,
      maxDelayMs: e.RETRY_MAX_DELAY_MS,
    },
    cache: { ttlMs: e.CACHE_TTL_SECONDS * 1000, maxEntries: e.CACHE_MAX_ENTRIES },
    circuit: { failureThreshold: e.CIRCUIT_FAILURE_THRESHOLD, cooldownMs: e.CIRCUIT_COOLDOWN_MS },
    routes,
    ...(e.USAGE_LOG_PATH ? { usageLogPath: e.USAGE_LOG_PATH } : {}),
  };
}
