export const PROVIDER_NAMES = ['openai', 'anthropic', 'ollama', 'mock'] as const;
export type ProviderName = (typeof PROVIDER_NAMES)[number];

export type Role = 'system' | 'user' | 'assistant';

export interface ChatMessage {
  role: Role;
  content: string;
}

/** Provider-neutral chat request. `model` is the provider-native model id. */
export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number | undefined;
  maxTokens?: number | undefined;
  topP?: number | undefined;
  stop?: string[] | undefined;
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export type FinishReason = 'stop' | 'length' | 'content_filter' | 'error';

export interface ChatResult {
  content: string;
  finishReason: FinishReason;
  usage: Usage;
}

export interface StreamChunk {
  delta: string;
  finishReason?: FinishReason;
  usage?: Usage;
}

export interface CallOptions {
  signal?: AbortSignal;
}

export interface LLMProvider {
  readonly name: ProviderName;
  chat(request: ChatRequest, options?: CallOptions): Promise<ChatResult>;
  stream(request: ChatRequest, options?: CallOptions): AsyncIterable<StreamChunk>;
}

export type FetchFn = typeof fetch;

export function makeUsage(promptTokens: number, completionTokens: number): Usage {
  return { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens };
}

/** Rough token estimate (~4 chars/token) used when a provider does not report usage. */
export function estimateTokens(text: string): number {
  return text.length === 0 ? 0 : Math.max(1, Math.ceil(text.length / 4));
}
