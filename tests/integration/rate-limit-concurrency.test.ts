import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRedisClient, type RedisClient } from '../../src/rate-limit/redis-client.js';
import { createSlidingWindowRateLimiter, type SlidingWindowRateLimiter } from '../../src/rate-limit/sliding-window-limiter.js';
import type { RateLimitResult } from '../../src/rate-limit/types.js';

describe('Distributed Sliding-Window Concurrency & Isolation Integration', () => {
  let redis: RedisClient;
  let limiter: SlidingWindowRateLimiter;

  beforeAll(async () => {
    redis = createRedisClient({
      host: '127.0.0.1',
      port: 6379,
    });
    await redis.connect();
    limiter = createSlidingWindowRateLimiter(redis, { keyPrefix: 'concurrency_test:' });
    await limiter.init();
  });

  afterAll(async () => {
    try {
      await redis.close();
    } catch {
      // Ignored
    }
  });

  it('should guarantee atomicity under 100 concurrent requests against a limit of 20', async () => {
    const routeId = `concurrent_100_20_${Date.now()}`;
    const limit = 20;
    const windowSec = 60;
    const totalRequests = 100;

    const promises: Promise<RateLimitResult>[] = [];
    for (let i = 0; i < totalRequests; i++) {
      promises.push(
        limiter.checkLimit({
          namespace: 'ip',
          identifier: '192.168.1.200',
          routeId,
          windowSec,
          limit,
        })
      );
    }

    const results = await Promise.all(promises);

    const allowedCount = results.filter((r) => r.allowed).length;
    const rejectedCount = results.filter((r) => !r.allowed).length;

    expect(allowedCount).toBe(20);
    expect(rejectedCount).toBe(80);

    // Verify rejected results contain retry-after and limit metadata
    const rejectedResults = results.filter((r) => !r.allowed);
    for (const r of rejectedResults) {
      expect(r.remaining).toBe(0);
      expect(r.limit).toBe(20);
      expect(r.retryAfterSec).toBeGreaterThanOrEqual(1);
    }
  });

  it('should isolate concurrent limits across multiple identities independently', async () => {
    const routeId = `multi_identity_${Date.now()}`;
    const limitPerUser = 10;
    const requestsPerUser = 30;

    const users = ['usr_alpha', 'usr_beta', 'usr_gamma'];

    const userPromises = users.map(async (userId) => {
      const promises: Promise<RateLimitResult>[] = [];
      for (let i = 0; i < requestsPerUser; i++) {
        promises.push(
          limiter.checkLimit({
            namespace: 'user',
            identifier: userId,
            routeId,
            windowSec: 60,
            limit: limitPerUser,
          })
        );
      }
      return {
        userId,
        results: await Promise.all(promises),
      };
    });

    const userResults = await Promise.all(userPromises);

    for (const { results } of userResults) {
      const allowed = results.filter((r) => r.allowed).length;
      const rejected = results.filter((r) => !r.allowed).length;

      expect(allowed).toBe(10);
      expect(rejected).toBe(20);
    }
  });

  it('should isolate rate limits across distinct routes for the same identity', async () => {
    const userId = `usr_route_isolation_${Date.now()}`;
    const limit = 5;

    // 10 concurrent requests to route A
    const routeAPromises = Array.from({ length: 10 }).map(() =>
      limiter.checkLimit({
        namespace: 'user',
        identifier: userId,
        routeId: 'route_checkout',
        windowSec: 60,
        limit,
      })
    );

    // 10 concurrent requests to route B
    const routeBPromises = Array.from({ length: 10 }).map(() =>
      limiter.checkLimit({
        namespace: 'user',
        identifier: userId,
        routeId: 'route_profile',
        windowSec: 60,
        limit,
      })
    );

    const [resultsA, resultsB] = await Promise.all([
      Promise.all(routeAPromises),
      Promise.all(routeBPromises),
    ]);

    const allowedA = resultsA.filter((r) => r.allowed).length;
    const allowedB = resultsB.filter((r) => r.allowed).length;

    expect(allowedA).toBe(5);
    expect(resultsA.filter((r) => !r.allowed).length).toBe(5);

    expect(allowedB).toBe(5);
    expect(resultsB.filter((r) => !r.allowed).length).toBe(5);
  });
});
