import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRedisClient, type RedisClient } from '../../src/rate-limit/redis-client.js';
import { RedisCacheStore } from '../../src/cache/cache-store.js';
import type { CacheEntry } from '../../src/cache/types.js';

describe('Redis Cache Store', () => {
  let redisClient: RedisClient;
  let cacheStore: RedisCacheStore;

  beforeAll(async () => {
    redisClient = createRedisClient({
      host: '127.0.0.1',
      port: 6379,
      keyPrefix: 'test_cache:',
    });
    await redisClient.connect();
    cacheStore = new RedisCacheStore(redisClient, { defaultTtlSec: 5 });
  });

  afterAll(async () => {
    await redisClient.close();
  });

  it('should return null for non-existent cache key', async () => {
    const res = await cacheStore.get('non_existent_key');
    expect(res).toBeNull();
  });

  it('should store and retrieve a cache entry with headers and body', async () => {
    const key = 'test_cache:item:1';
    const entry: CacheEntry = {
      statusCode: 200,
      headers: { 'content-type': 'application/json', 'x-custom': 'val' },
      body: JSON.stringify({ message: 'cached hello' }),
      createdAt: Date.now(),
      expiresAt: Date.now() + 5000,
    };

    const stored = await cacheStore.set(key, entry, 5);
    expect(stored).toBe(true);

    const retrieved = await cacheStore.get(key);
    expect(retrieved).not.toBeNull();
    expect(retrieved?.statusCode).toBe(200);
    expect(retrieved?.headers['content-type']).toBe('application/json');
    expect(retrieved?.body).toBe(JSON.stringify({ message: 'cached hello' }));
  });

  it('should delete a cache entry', async () => {
    const key = 'test_cache:item:del';
    const entry: CacheEntry = {
      statusCode: 200,
      headers: {},
      body: 'temp',
      createdAt: Date.now(),
      expiresAt: Date.now() + 5000,
    };

    await cacheStore.set(key, entry, 5);
    expect(await cacheStore.get(key)).not.toBeNull();

    const deleted = await cacheStore.delete(key);
    expect(deleted).toBe(true);
    expect(await cacheStore.get(key)).toBeNull();
  });

  it('should return null for expired entry in get()', async () => {
    const key = 'test_cache:item:expired';
    const entry: CacheEntry = {
      statusCode: 200,
      headers: {},
      body: 'old data',
      createdAt: Date.now() - 10000,
      expiresAt: Date.now() - 1000, // already expired
    };

    await cacheStore.set(key, entry, 10);
    const retrieved = await cacheStore.get(key);
    expect(retrieved).toBeNull();
  });
});
