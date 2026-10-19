import { GatewayError } from '../errors.js';
import type { ProviderName } from '../types.js';
import { PROVIDER_NAMES } from '../types.js';

export interface Target {
  provider: ProviderName;
  model: string;
}

export function parseTarget(spec: string): Target | undefined {
  const slash = spec.indexOf('/');
  if (slash <= 0) return undefined;
  const provider = spec.slice(0, slash);
  const model = spec.slice(slash + 1);
  if (!model || !(PROVIDER_NAMES as readonly string[]).includes(provider)) return undefined;
  return { provider: provider as ProviderName, model };
}

function inferProvider(model: string): ProviderName | undefined {
  if (/^(gpt-|o\d|chatgpt-)/.test(model)) return 'openai';
  if (model.startsWith('claude-')) return 'anthropic';
  return undefined;
}

/**
 * Resolves a requested model into an ordered list of provider targets (the fallback chain):
 *  - aliases from MODEL_ROUTES, e.g. "fast" -> openai/gpt-4o-mini, anthropic/claude-3-5-haiku
 *  - explicit "provider/model", e.g. "ollama/llama3.1"
 *  - bare model names inferred by prefix, e.g. "gpt-4o-mini" -> openai
 * Targets whose provider is not configured are skipped.
 */
export class ModelRouter {
  private readonly routes: Map<string, Target[]>;

  constructor(
    routes: Record<string, string[]>,
    private readonly enabled: ReadonlySet<ProviderName>,
  ) {
    this.routes = new Map(
      Object.entries(routes).map(([alias, specs]) => [
        alias,
        specs.map((s) => parseTarget(s)).filter((t): t is Target => t !== undefined),
      ]),
    );
  }

  resolve(model: string): Target[] {
    let candidates: Target[];
    const alias = this.routes.get(model);
    if (alias) {
      candidates = alias;
    } else {
      const explicit = parseTarget(model);
      const inferred = inferProvider(model);
      if (explicit) candidates = [explicit];
      else if (inferred) candidates = [{ provider: inferred, model }];
      else throw new GatewayError(400, `unknown model "${model}"`, 'invalid_request_error');
    }
    const available = candidates.filter((t) => this.enabled.has(t.provider));
    if (available.length === 0) {
      const wanted = [...new Set(candidates.map((t) => t.provider))].join(', ');
      throw new GatewayError(
        400,
        `model "${model}" needs a provider that is not configured (${wanted})`,
        'invalid_request_error',
      );
    }
    return available;
  }

  listModels(): { id: string; targets: string[] }[] {
    return [...this.routes.entries()]
      .map(([id, targets]) => ({
        id,
        targets: targets
          .filter((t) => this.enabled.has(t.provider))
          .map((t) => `${t.provider}/${t.model}`),
      }))
      .filter((m) => m.targets.length > 0);
  }
}
