export interface SseEvent {
  event?: string;
  data: string;
}

async function* lines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let index: number;
    while ((index = buffer.indexOf('\n')) !== -1) {
      yield buffer.slice(0, index).replace(/\r$/, '');
      buffer = buffer.slice(index + 1);
    }
  }
  buffer += decoder.decode();
  if (buffer.length > 0) yield buffer.replace(/\r$/, '');
}

/** Parse a `text/event-stream` body into events (spec-compliant for data/event/comments). */
export async function* parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  let event: string | undefined;
  let data: string[] = [];
  for await (const line of lines(body)) {
    if (line === '') {
      if (data.length > 0)
        yield event === undefined ? { data: data.join('\n') } : { event, data: data.join('\n') };
      event = undefined;
      data = [];
      continue;
    }
    if (line.startsWith(':')) continue; // comment / keep-alive
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
    if (field === 'data') data.push(value);
    else if (field === 'event') event = value;
  }
  if (data.length > 0)
    yield event === undefined ? { data: data.join('\n') } : { event, data: data.join('\n') };
}

/** Parse newline-delimited JSON (used by Ollama streaming). */
export async function* parseNdjson<T>(body: ReadableStream<Uint8Array>): AsyncGenerator<T> {
  for await (const line of lines(body)) {
    if (line.trim()) yield JSON.parse(line) as T;
  }
}
