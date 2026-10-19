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
import { parseNdjson } from './streams.js';

interface OllamaChunk {
  message?: { content?: string };
  done?: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
  error?: string;
}

export interface OllamaOptions {
  baseUrl?: string;
  fetch?: FetchFn;
}

/** Adapter for a local Ollama server (`/api/chat`, NDJSON streaming). */
export class OllamaProvider implements LLMProvider {
  readonly name = 'ollama' as const;
  private readonly baseUrl: string;
  private readonly fetchFn: FetchFn;

  constructor(options: OllamaOptions = {}) {
    this.baseUrl = (options.baseUrl ?? 'http://localhost:11434').replace(/\/$/, '');
    this.fetchFn = options.fetch ?? fetch;
  }

  private body(request: ChatRequest, stream: boolean): Record<string, unknown> {
    return {
      model: request.model,
      messages: request.messages,
      stream,
      options: {
        temperature: request.temperature,
        top_p: request.topP,
        num_predict: request.maxTokens,
        stop: request.stop,
      },
    };
  }

  async chat(request: ChatRequest, options?: CallOptions): Promise<ChatResult> {
    const response = await postJson(
      this.fetchFn,
      this.name,
      `${this.baseUrl}/api/chat`,
      {},
      this.body(request, false),
      options,
    );
    const json = await readJson<OllamaChunk>(response, this.name);
    if (json.error) throw new ProviderError(`ollama error: ${json.error}`, this.name, 200, false);
    return {
      content: json.message?.content ?? '',
      finishReason: mapFinishReason(json.done_reason),
      usage: makeUsage(json.prompt_eval_count ?? 0, json.eval_count ?? 0),
    };
  }

  async *stream(request: ChatRequest, options?: CallOptions): AsyncGenerator<StreamChunk> {
    const response = await postJson(
      this.fetchFn,
      this.name,
      `${this.baseUrl}/api/chat`,
      {},
      this.body(request, true),
      options,
    );
    if (!response.body)
      throw new ProviderError('ollama returned an empty stream', this.name, 200, true);
    for await (const chunk of parseNdjson<OllamaChunk>(response.body)) {
      if (chunk.error)
        throw new ProviderError(`ollama error: ${chunk.error}`, this.name, 200, false);
      if (chunk.done) {
        yield {
          delta: chunk.message?.content ?? '',
          finishReason: mapFinishReason(chunk.done_reason),
          usage: makeUsage(chunk.prompt_eval_count ?? 0, chunk.eval_count ?? 0),
        };
        return;
      }
      if (chunk.message?.content) yield { delta: chunk.message.content };
    }
  }
}
