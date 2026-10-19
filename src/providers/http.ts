import { ProviderError, isRetryableStatus, parseRetryAfter } from '../errors.js';
import type { CallOptions, FetchFn, ProviderName } from '../types.js';

/** POST JSON and return the response, converting failures into classified ProviderErrors. */
export async function postJson(
  fetchFn: FetchFn,
  provider: ProviderName,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  options: CallOptions = {},
): Promise<Response> {
  let response: Response;
  try {
    response = await fetchFn(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: options.signal ?? null,
    });
  } catch (error) {
    const aborted = error instanceof Error && error.name === 'AbortError';
    const timedOut = error instanceof Error && error.name === 'TimeoutError';
    if (aborted && !timedOut) throw error; // client went away: do not retry
    const reason = error instanceof Error ? error.message : String(error);
    throw new ProviderError(`${provider} request failed: ${reason}`, provider, undefined, true);
  }
  if (!response.ok) {
    const text = (await response.text().catch(() => '')).slice(0, 500);
    throw new ProviderError(
      `${provider} returned HTTP ${response.status}: ${text}`,
      provider,
      response.status,
      isRetryableStatus(response.status),
      parseRetryAfter(response.headers.get('retry-after')),
    );
  }
  return response;
}

export async function readJson<T>(response: Response, provider: ProviderName): Promise<T> {
  try {
    return (await response.json()) as T;
  } catch {
    throw new ProviderError(`${provider} returned invalid JSON`, provider, response.status, true);
  }
}
