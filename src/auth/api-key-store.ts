import { createHash } from 'node:crypto';
import type { ApiKeyDefinition } from './types.js';

export interface StoredApiKey {
  readonly id: string;
  readonly keyHash: string;
  readonly userId: string;
  readonly roles: readonly string[];
  readonly tier?: string | undefined;
  readonly revoked?: boolean | undefined;
  readonly expiresAt?: number | undefined; // Unix timestamp in ms
}

export interface ApiKeyStore {
  getByKeyHash(keyHash: string): Promise<StoredApiKey | null>;
}

export function hashApiKey(rawKey: string): string {
  return createHash('sha256').update(rawKey, 'utf-8').digest('hex');
}

export class InMemoryApiKeyStore implements ApiKeyStore {
  private readonly keysByHash = new Map<string, StoredApiKey>();

  constructor(initialKeys: readonly ApiKeyDefinition[] = []) {
    for (const keyDef of initialKeys) {
      this.registerKey(keyDef);
    }
  }

  public registerKey(keyDef: ApiKeyDefinition): void {
    const keyHash = hashApiKey(keyDef.key);

    let expiresAtMs: number | undefined;
    if (typeof keyDef.expiresAt === 'number') {
      expiresAtMs = keyDef.expiresAt > 10000000000 ? keyDef.expiresAt : keyDef.expiresAt * 1000;
    } else if (typeof keyDef.expiresAt === 'string') {
      expiresAtMs = new Date(keyDef.expiresAt).getTime();
    }

    const storedKey: StoredApiKey = {
      id: keyDef.id,
      keyHash,
      userId: keyDef.userId,
      roles: Object.freeze([...keyDef.roles]),
      tier: keyDef.tier,
      revoked: keyDef.revoked ?? false,
      expiresAt: expiresAtMs,
    };

    this.keysByHash.set(keyHash, storedKey);
  }

  public async getByKeyHash(keyHash: string): Promise<StoredApiKey | null> {
    return this.keysByHash.get(keyHash) ?? null;
  }

  public get size(): number {
    return this.keysByHash.size;
  }
}
