import type { AuthContext } from './types.js';

interface CacheEntry {
  readonly authContext: AuthContext;
  readonly expiresAt: number;
}

export interface ApiKeyCacheOptions {
  readonly maxEntries?: number | undefined;
  readonly ttlMs?: number | undefined;
}

export class ApiKeyCache {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly maxEntries: number;
  private readonly ttlMs: number;

  constructor(options: ApiKeyCacheOptions = {}) {
    this.maxEntries = Math.max(1, options.maxEntries ?? 1000);
    this.ttlMs = Math.max(1, options.ttlMs ?? 60000);
  }

  public get(keyHash: string): AuthContext | null {
    const entry = this.cache.get(keyHash);
    if (!entry) {
      return null;
    }

    // Check expiration
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(keyHash);
      return null;
    }

    // Refresh LRU order (delete & re-insert to move to MRU)
    this.cache.delete(keyHash);
    this.cache.set(keyHash, entry);

    return entry.authContext;
  }

  public set(keyHash: string, authContext: AuthContext): void {
    if (this.cache.has(keyHash)) {
      this.cache.delete(keyHash);
    } else if (this.cache.size >= this.maxEntries) {
      // Evict oldest (least-recently-used) key
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey !== undefined) {
        this.cache.delete(oldestKey);
      }
    }

    this.cache.set(keyHash, {
      authContext,
      expiresAt: Date.now() + this.ttlMs,
    });
  }

  public invalidate(keyHash: string): void {
    this.cache.delete(keyHash);
  }

  public clear(): void {
    this.cache.clear();
  }

  public get size(): number {
    return this.cache.size;
  }
}
