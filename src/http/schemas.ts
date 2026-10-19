import { z } from 'zod';

export const ChatMessageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant']),
  content: z.string().max(200_000),
});

export const ChatCompletionRequestSchema = z
  .object({
    model: z
      .string()
      .min(1)
      .describe(
        'Alias (e.g. "fast"), "provider/model" (e.g. "ollama/llama3.1") or a bare model id.',
      ),
    messages: z.array(ChatMessageSchema).min(1).max(500),
    temperature: z.number().min(0).max(2).optional(),
    max_tokens: z.number().int().positive().max(200_000).optional(),
    top_p: z.number().min(0).max(1).optional(),
    stop: z.union([z.string(), z.array(z.string()).max(4)]).optional(),
    stream: z.boolean().default(false),
    user: z.string().max(256).optional(),
  })
  .describe('OpenAI-compatible chat completion request.');

export type ChatCompletionRequest = z.infer<typeof ChatCompletionRequestSchema>;

const UsageSchema = z.object({
  prompt_tokens: z.number().int(),
  completion_tokens: z.number().int(),
  total_tokens: z.number().int(),
});

export const ChatCompletionResponseSchema = z.object({
  id: z.string(),
  object: z.literal('chat.completion'),
  created: z.number().int(),
  model: z.string(),
  choices: z.array(
    z.object({
      index: z.number().int(),
      message: z.object({ role: z.literal('assistant'), content: z.string() }),
      finish_reason: z.string(),
    }),
  ),
  usage: UsageSchema,
  gateway: z.object({
    provider: z.string(),
    cached: z.boolean(),
    attempts: z.number().int(),
  }),
});

export const ErrorSchema = z.object({
  error: z.object({
    message: z.string(),
    type: z.string(),
    details: z.unknown().optional(),
  }),
});

export const ModelsResponseSchema = z.object({
  object: z.literal('list'),
  data: z.array(
    z.object({
      id: z.string(),
      object: z.literal('model'),
      owned_by: z.string(),
      targets: z.array(z.string()),
    }),
  ),
});

export const UsageSummarySchema = z.object({
  apiKey: z.string(),
  requests: z.number().int(),
  errors: z.number().int(),
  cachedRequests: z.number().int(),
  promptTokens: z.number().int(),
  completionTokens: z.number().int(),
  totalTokens: z.number().int(),
  byModel: z.record(
    z.string(),
    z.object({ requests: z.number().int(), totalTokens: z.number().int() }),
  ),
});

export const HealthSchema = z.object({
  status: z.literal('ok'),
  uptimeSeconds: z.number(),
  providers: z.record(z.string(), z.object({ circuit: z.enum(['closed', 'open', 'half_open']) })),
  cache: z.object({ entries: z.number().int(), hits: z.number().int(), misses: z.number().int() }),
});
