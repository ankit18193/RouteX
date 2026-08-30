import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createRedisClient, type RedisClient } from '../../src/rate-limit/redis-client.js';
import { CacheManager } from '../../src/cache/cache-manager.js';
import type { RouteDefinition } from '../../src/types/index.js';
import type { FastifyRequest } from 'fastify';

describe('CacheManager Unit & Integration', () => {
  let redisClient: RedisClient;
  let cacheManager: CacheManager;

  const mockRoute: RouteDefinition = {
    id: 'route_users',
    pathPrefix: '/users',
    upstream: 'http://localhost:4001',
    stripPrefix: false,
    methods: ['GET', 'POST'],
    auth: { mode: 'public', requiredRoles: [] },
    timeouts: { connectTimeoutMs: 1000, responseTimeoutMs: 3000 },
    cache: {
      enabled: true,
      ttlSec: 60,
      respectCacheControl: true,
      maxBodyBytes: 1024 * 1024,
      varyBy: ['accept'],
      allowAuthenticated: false,
    },
  };

  beforeAll(async () => {
    redisClient = createRedisClient({
      host: '127.0.0.1',
      port: 6379,
      keyPrefix: 'cm_test:',
    });
    await redisClient.connect();
    cacheManager = new CacheManager(redisClient, { keyPrefix: 'cm_test:' });
  });

  beforeEach(async () => {
    const keys = await redisClient.rawClient.keys('cm_test:*');
    if (keys.length > 0) {
      await redisClient.rawClient.del(...keys);
    }
  });

  afterAll(async () => {
    await redisClient.close();
  });

  it('should return BYPASS if route cache is not enabled', async () => {
    const routeDisabled = { ...mockRoute, cache: { ...mockRoute.cache!, enabled: false } };
    const mockReq = { method: 'GET', url: '/users/1', headers: {} } as FastifyRequest;

    const res = await cacheManager.lookup(mockReq, routeDisabled);
    expect(res.status).toBe('BYPASS');
  });

  it('should return MISS on first lookup and HIT after storing response', async () => {
    const mockReq = {
      method: 'GET',
      url: '/users/1',
      headers: { accept: 'application/json' },
    } as FastifyRequest;

    const lookup1 = await cacheManager.lookup(mockReq, mockRoute);
    expect(lookup1.status).toBe('MISS');
    expect(lookup1.cacheKey).toBeDefined();

    const stored = await cacheManager.store(
      lookup1.cacheKey!,
      200,
      { 'content-type': 'application/json' },
      JSON.stringify({ id: 1, name: 'Alice' }),
      mockRoute.cache
    );
    expect(stored).toBe(true);

    const lookup2 = await cacheManager.lookup(mockReq, mockRoute);
    expect(lookup2.status).toBe('HIT');
    if (lookup2.status === 'HIT') {
      expect(lookup2.entry.statusCode).toBe(200);
      expect(lookup2.entry.body).toBe(JSON.stringify({ id: 1, name: 'Alice' }));
      expect(lookup2.ageSec).toBeGreaterThanOrEqual(0);
    }
  });

  it('should not store response if status is not 200 or body is too large', async () => {
    const res500 = await cacheManager.store('key1', 500, {}, 'error', mockRoute.cache);
    expect(res500).toBe(false);

    const routeTiny = {
      ...mockRoute,
      cache: { ...mockRoute.cache!, maxBodyBytes: 10 },
    };
    const resOversized = await cacheManager.store(
      'key2',
      200,
      {},
      '123456789012345',
      routeTiny.cache
    );
    expect(resOversized).toBe(false);
  });
});
