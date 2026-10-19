import { ProviderError } from '../errors.js';
import type {
  CallOptions,
  ChatRequest,
  ChatResult,
  FetchFn,
  LLMProvider,
  StreamChunk,
} from '../types.js';
import { makeUsage } from '../types.js';
import { postJson, readJson } from './http.js';
import { mapFinishReason } from './openai.js';
import { parseSse } from './streams.js';

interface AnthropicResponse {
  content: { type: string; text?: string }[];
  stop_reason?: string | null;
  usage: { input_tokens: number; output_tokens: number };
}

interface AnthropicStreamEvent {
  type: string;
  message?: { usage?: { input_tokens?: number; output_tokens?: number } };
  delta?: { type?: string; text?: string; stop_reason?: string | null };
  usage?: { output_tokens?: number };
  error?: { type?: string; message?: string };
}

export interface AnthropicOptions {
  apiKey: string;
  baseUrl?: string;
  apiVersion?: string;
  defaultMaxTokens?: number;
  fetch?: FetchFn;
}

const STOP_REASONS: Record<string, string> = {
  end_turn: 'stop',
  stop_sequence: 'stop',
  max_tokens: 'length',
};

/** Adapter for the Anthropic Messages API (system prompt is a top-level field). */
export class AnthropicProvider implements LLMProvider {
  readonly name = 'anthropic' as const;
  private readonly baseUrl: string;
  private readonly fetchFn: FetchFn;

  constructor(private readonly options: AnthropicOptions) {
    this.baseUrl = (options.baseUrl ?? 'https://api.anthropic.com').replace(/\/$/, '');
    this.fetchFn = options.fetch ?? fetch;
  }

  private headers(): Record<string, string> {
    return {
      'x-api-key': this.options.apiKey,
      'anthropic-version': this.options.apiVersion ?? '2023-06-01',
    };
  }

  body(request: ChatRequest, stream: boolean): Record<string, unknown> {
    const system = request.messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n\n');
    return {
      model: request.model,
      max_tokens: request.maxTokens ?? this.options.defaultMaxTokens ?? 1024,
      ...(system ? { system } : {}),
      messages: request.messages
        .filter((m) => m.role !== 'system')
        .map((m) => ({ role: m.role, content: m.content })),
      temperature: request.temperature,
      top_p: request.topP,
      stop_sequences: request.stop,
      stream,
    };
  }

  async chat(request: ChatRequest, options?: CallOptions): Promise<ChatResult> {
    const response = await postJson(
      this.fetchFn,
      this.name,
      `${this.baseUrl}/v1/messages`,
      this.headers(),
      this.body(request, false),
      options,
    );
    const json = await readJson<AnthropicResponse>(response, this.name);
    const content = json.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text ?? '')
      .join('');
    return {
      content,
      finishReason: mapFinishReason(STOP_REASONS[json.stop_reason ?? ''] ?? json.stop_reason),
      usage: makeUsage(json.usage.input_tokens, json.usage.output_tokens),
    };
  }

  async *stream(request: ChatRequest, options?: CallOptions): AsyncGenerator<StreamChunk> {
    const response = await postJson(
      this.fetchFn,
      this.name,
      `${this.baseUrl}/v1/messages`,
      this.headers(),
      this.body(request, true),
      options,
    );
    if (!response.body)
      throw new ProviderError('anthropic returned an empty stream', this.name, 200, true);
    let inputTokens = 0;
    for await (const event of parseSse(response.body)) {
      const json = JSON.parse(event.data) as AnthropicStreamEvent;
      switch (json.type) {
        case 'message_start':
          inputTokens = json.message?.usage?.input_tokens ?? 0;
          break;
        case 'content_block_delta':
          if (json.delta?.type === 'text_delta' && json.delta.text)
            yield { delta: json.delta.text };
          break;
        case 'message_delta': {
          const reason = json.delta?.stop_reason ?? '';
          yield {
            delta: '',
            finishReason: mapFinishReason(STOP_REASONS[reason] ?? reason),
            usage: makeUsage(inputTokens, json.usage?.output_tokens ?? 0),
          };
          break;
        }
        case 'error':
          throw new ProviderError(
            `anthropic stream error: ${json.error?.message ?? 'unknown'}`,
            this.name,
            undefined,
            json.error?.type === 'overloaded_error',
          );
        default:
          break;
      }
    }
  }
}
