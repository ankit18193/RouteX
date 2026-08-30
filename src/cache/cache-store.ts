import type { RedisClient } from '../rate-limit/redis-client.js';
import type { CacheEntry } from './types.js';

export interface CacheStoreOptions {
  readonly defaultTtlSec?: number | undefined;
}

export class RedisCacheStore {
  private readonly redisClient: RedisClient;
  private readonly defaultTtlSec: number;

  constructor(redisClient: RedisClient, options: CacheStoreOptions = {}) {
    this.redisClient = redisClient;
    this.defaultTtlSec = options.defaultTtlSec ?? 30;
  }

  /**
   * Retrieve a cached response entry from Redis.
   */
  public async get(key: string): Promise<CacheEntry | null> {
    try {
      const raw = await this.redisClient.rawClient.get(key);
      if (!raw) {
        return null;
      }

      const parsed = JSON.parse(raw) as CacheEntry;
      if (!parsed || typeof parsed !== 'object' || typeof parsed.statusCode !== 'number') {
        return null;
      }

      // Verify expiration timestamp
      if (typeof parsed.expiresAt === 'number' && Date.now() >= parsed.expiresAt) {
        // Asynchronously delete expired entry
        this.delete(key).catch(() => {});
        return null;
      }

      return parsed;
    } catch {
      // Degrade gracefully on Redis errors
      return null;
    }
  }

  /**
   * Store a response entry in Redis with specified TTL.
   */
  public async set(key: string, entry: CacheEntry, ttlSec?: number): Promise<boolean> {
    try {
      const ttl = Math.max(1, ttlSec ?? this.defaultTtlSec);
      const serialized = JSON.stringify(entry);
      const res = await this.redisClient.rawClient.set(key, serialized, 'EX', ttl);
      return res === 'OK';
    } catch {
      // Degrade gracefully on Redis errors
      return false;
    }
  }

  /**
   * Delete a cached entry from Redis.
   */
  public async delete(key: string): Promise<boolean> {
    try {
      const deleted = await this.redisClient.rawClient.del(key);
      return deleted > 0;
    } catch {
      return false;
    }
  }
}
