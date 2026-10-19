import { describe, expect, it } from 'vitest';
import { parseNdjson, parseSse } from '../src/providers/streams.js';
import { streamResponse } from './helpers.js';

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}

describe('parseSse', () => {
  it('handles events split across network chunks, comments, CRLF and multi-line data', async () => {
    const body = streamResponse([
      ': keep-alive\n\nevent: message_start\nda',
      'ta: {"a":1}\r\n\r\ndata: line1\ndata: line2\n\n',
      'data: tail-without-blank-line',
    ]).body;
    if (!body) throw new Error('no body');
    expect(await collect(parseSse(body))).toEqual([
      { event: 'message_start', data: '{"a":1}' },
      { data: 'line1\nline2' },
      { data: 'tail-without-blank-line' },
    ]);
  });
});

describe('parseNdjson', () => {
  it('parses one JSON object per line and skips blank lines', async () => {
    const body = streamResponse(['{"a":1}\n\n{"b"', ':2}\n'], 'application/x-ndjson').body;
    if (!body) throw new Error('no body');
    expect(await collect(parseNdjson(body))).toEqual([{ a: 1 }, { b: 2 }]);
  });
});
