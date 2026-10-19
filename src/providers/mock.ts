import type { CallOptions, ChatRequest, ChatResult, LLMProvider, StreamChunk } from '../types.js';
import { estimateTokens, makeUsage } from '../types.js';

/**
 * Deterministic offline provider: echoes the last user message. Lets the gateway run end-to-end
 * (docker compose up, curl, SDKs) without any API key. Enabled with ENABLE_MOCK_PROVIDER=true.
 */
export class MockProvider implements LLMProvider {
  readonly name = 'mock' as const;

  private reply(request: ChatRequest): string {
    const lastUser = [...request.messages].reverse().find((m) => m.role === 'user');
    return `Echo from ${request.model}: ${lastUser?.content ?? ''}`;
  }

  private usage(request: ChatRequest, content: string) {
    return makeUsage(
      estimateTokens(request.messages.map((m) => m.content).join(' ')),
      estimateTokens(content),
    );
  }

  chat(request: ChatRequest, options?: CallOptions): Promise<ChatResult> {
    options?.signal?.throwIfAborted();
    const content = this.reply(request);
    return Promise.resolve({ content, finishReason: 'stop', usage: this.usage(request, content) });
  }

  async *stream(request: ChatRequest, options?: CallOptions): AsyncGenerator<StreamChunk> {
    const content = this.reply(request);
    const words = content.split(/(?<= )/);
    for (const word of words) {
      options?.signal?.throwIfAborted();
      await Promise.resolve();
      yield { delta: word };
    }
    yield { delta: '', finishReason: 'stop', usage: this.usage(request, content) };
  }
}
