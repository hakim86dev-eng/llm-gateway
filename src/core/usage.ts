import { appendFile } from 'node:fs/promises';
import type { ProviderName, Usage } from '../types.js';

export interface UsageEvent {
  timestamp: string;
  requestId: string;
  apiKey: string;
  requestedModel: string;
  provider?: ProviderName;
  model?: string;
  stream: boolean;
  cached: boolean;
  status: 'ok' | 'error';
  attempts: number;
  latencyMs: number;
  usage: Usage;
  error?: string;
}

export interface UsageSummary {
  apiKey: string;
  requests: number;
  errors: number;
  cachedRequests: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  byModel: Record<string, { requests: number; totalTokens: number }>;
}

export type UsageSink = (event: UsageEvent) => Promise<void>;

/** Appends one JSON line per request; plug a log shipper or warehouse loader on the file. */
export const jsonlSink =
  (path: string): UsageSink =>
  (event) =>
    appendFile(path, `${JSON.stringify(event)}\n`, 'utf8');

/** In-memory aggregation per API key plus optional durable sink. */
export class UsageTracker {
  private readonly summaries = new Map<string, UsageSummary>();

  constructor(
    private readonly sink?: UsageSink,
    private readonly onSinkError: (error: unknown) => void = () => undefined,
  ) {}

  record(event: UsageEvent): void {
    const s = this.summaries.get(event.apiKey) ?? {
      apiKey: event.apiKey,
      requests: 0,
      errors: 0,
      cachedRequests: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      byModel: {},
    };
    s.requests += 1;
    if (event.status === 'error') s.errors += 1;
    if (event.cached) s.cachedRequests += 1;
    // Cached responses cost nothing upstream, so they don't count towards token spend.
    if (!event.cached) {
      s.promptTokens += event.usage.promptTokens;
      s.completionTokens += event.usage.completionTokens;
      s.totalTokens += event.usage.totalTokens;
    }
    const key =
      event.provider && event.model ? `${event.provider}/${event.model}` : event.requestedModel;
    const model = (s.byModel[key] ??= { requests: 0, totalTokens: 0 });
    model.requests += 1;
    if (!event.cached) model.totalTokens += event.usage.totalTokens;
    this.summaries.set(event.apiKey, s);
    this.sink?.(event).catch(this.onSinkError);
  }

  summary(apiKey: string): UsageSummary {
    return (
      this.summaries.get(apiKey) ?? {
        apiKey,
        requests: 0,
        errors: 0,
        cachedRequests: 0,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        byModel: {},
      }
    );
  }
}
