import { createHash, timingSafeEqual } from 'node:crypto';
import type { ApiKeyConfig } from '../config.js';

export interface ApiKeyRecord {
  name: string;
  rpm: number;
}

const sha256 = (value: string): Buffer => createHash('sha256').update(value).digest();

/** Holds only SHA-256 digests of gateway keys; plaintext keys are never kept in memory maps. */
export class ApiKeyStore {
  private readonly byHash = new Map<string, { digest: Buffer; record: ApiKeyRecord }>();

  constructor(keys: ApiKeyConfig[]) {
    for (const { name, key, rpm } of keys) {
      const digest = sha256(key);
      this.byHash.set(digest.toString('hex'), { digest, record: { name, rpm } });
    }
  }

  /** Accepts `Authorization: Bearer <key>` (OpenAI SDK compatible) or `x-api-key: <key>`. */
  authenticate(headers: {
    authorization?: string | undefined;
    'x-api-key'?: string | string[] | undefined;
  }): ApiKeyRecord | undefined {
    const bearer = headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
    const header = headers['x-api-key'];
    const presented = bearer ?? (Array.isArray(header) ? header[0] : header);
    if (!presented) return undefined;
    const digest = sha256(presented.trim());
    const match = this.byHash.get(digest.toString('hex'));
    return match && timingSafeEqual(match.digest, digest) ? match.record : undefined;
  }
}
