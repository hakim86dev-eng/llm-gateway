import { ProviderError } from '../errors.js';
import type {
  CallOptions,
  ChatRequest,
  ChatResult,
  FetchFn,
  FinishReason,
  LLMProvider,
  StreamChunk,
} from '../types.js';
import { estimateTokens, makeUsage } from '../types.js';
import { postJson, readJson } from './http.js';
import { parseSse } from './streams.js';

interface OpenAIChoice {
  message?: { content?: string | null };
  delta?: { content?: string | null };
  finish_reason?: string | null;
}
interface OpenAIUsage {
  prompt_tokens: number;
  completion_tokens: number;
}
interface OpenAIResponse {
  choices: OpenAIChoice[];
  usage?: OpenAIUsage;
}

export function mapFinishReason(reason: string | null | undefined): FinishReason {
  switch (reason) {
    case 'length':
    case 'max_tokens':
      return 'length';
    case 'content_filter':
      return 'content_filter';
    default:
      return 'stop';
  }
}

export interface OpenAIOptions {
  apiKey: string;
  baseUrl?: string;
  fetch?: FetchFn;
}

/** Adapter for OpenAI and any OpenAI-compatible API (Azure proxies, vLLM, Together, Groq...). */
export class OpenAIProvider implements LLMProvider {
  readonly name = 'openai' as const;
  private readonly baseUrl: string;
  private readonly fetchFn: FetchFn;

  constructor(private readonly options: OpenAIOptions) {
    this.baseUrl = (options.baseUrl ?? 'https://api.openai.com/v1').replace(/\/$/, '');
    this.fetchFn = options.fetch ?? fetch;
  }

  private body(request: ChatRequest, stream: boolean): Record<string, unknown> {
    return {
      model: request.model,
      messages: request.messages,
      temperature: request.temperature,
      max_tokens: request.maxTokens,
      top_p: request.topP,
      stop: request.stop,
      stream,
      ...(stream ? { stream_options: { include_usage: true } } : {}),
    };
  }

  private headers(): Record<string, string> {
    return { authorization: `Bearer ${this.options.apiKey}` };
  }

  async chat(request: ChatRequest, options?: CallOptions): Promise<ChatResult> {
    const url = `${this.baseUrl}/chat/completions`;
    const response = await postJson(
      this.fetchFn,
      this.name,
      url,
      this.headers(),
      this.body(request, false),
      options,
    );
    const json = await readJson<OpenAIResponse>(response, this.name);
    const choice = json.choices[0];
    if (!choice) throw new ProviderError('openai returned no choices', this.name, 200, true);
    const content = choice.message?.content ?? '';
    const usage = json.usage
      ? makeUsage(json.usage.prompt_tokens, json.usage.completion_tokens)
      : makeUsage(
          estimateTokens(request.messages.map((m) => m.content).join(' ')),
          estimateTokens(content),
        );
    return { content, finishReason: mapFinishReason(choice.finish_reason), usage };
  }

  async *stream(request: ChatRequest, options?: CallOptions): AsyncGenerator<StreamChunk> {
    const url = `${this.baseUrl}/chat/completions`;
    const response = await postJson(
      this.fetchFn,
      this.name,
      url,
      this.headers(),
      this.body(request, true),
      options,
    );
    if (!response.body)
      throw new ProviderError('openai returned an empty stream', this.name, 200, true);
    for await (const event of parseSse(response.body)) {
      if (event.data === '[DONE]') return;
      const json = JSON.parse(event.data) as OpenAIResponse;
      const choice = json.choices[0];
      const chunk: StreamChunk = { delta: choice?.delta?.content ?? '' };
      if (choice?.finish_reason) chunk.finishReason = mapFinishReason(choice.finish_reason);
      if (json.usage)
        chunk.usage = makeUsage(json.usage.prompt_tokens, json.usage.completion_tokens);
      if (chunk.delta || chunk.finishReason || chunk.usage) yield chunk;
    }
  }
}
