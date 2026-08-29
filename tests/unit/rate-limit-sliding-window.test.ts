import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { RedisClient, createRedisClient } from '../../src/rate-limit/redis-client.js';
import { SlidingWindowRateLimiter } from '../../src/rate-limit/sliding-window-limiter.js';
import { ServiceUnavailableError } from '../../src/errors/gateway-error.js';

describe('SlidingWindowRateLimiter Unit & Boundary Tests', () => {
  let redis: RedisClient;
  let limiter: SlidingWindowRateLimiter;

  beforeAll(async () => {
    redis = createRedisClient({
      host: '127.0.0.1',
      port: 6379,
    });
    await redis.connect();
  });

  afterAll(async () => {
    await redis.close();
  });

  beforeEach(() => {
    limiter = new SlidingWindowRateLimiter(redis, { keyPrefix: 'test_sw:' });
  });

  it('should allow first request and report remaining limit', async () => {
    const routeId = `test_first_${Date.now()}`;
    const res = await limiter.checkLimit({
      namespace: 'ip',
      identifier: '127.0.0.1',
      routeId,
      windowSec: 60,
      limit: 5,
    });

    expect(res.allowed).toBe(true);
    expect(res.limit).toBe(5);
    expect(res.remaining).toBe(4);
    expect(res.resetAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
    expect(res.retryAfterSec).toBe(0);
  });

  it('should correctly decrement remaining on successive requests up to limit', async () => {
    const routeId = `test_sequence_${Date.now()}`;
    const baseReq = {
      namespace: 'user' as const,
      identifier: 'usr_seq_01',
      routeId,
      windowSec: 60,
      limit: 3,
    };

    const res1 = await limiter.checkLimit(baseReq);
    expect(res1.allowed).toBe(true);
    expect(res1.remaining).toBe(2);

    const res2 = await limiter.checkLimit(baseReq);
    expect(res2.allowed).toBe(true);
    expect(res2.remaining).toBe(1);

    const res3 = await limiter.checkLimit(baseReq);
    expect(res3.allowed).toBe(true);
    expect(res3.remaining).toBe(0);

    // 4th request -> Rejected
    const res4 = await limiter.checkLimit(baseReq);
    expect(res4.allowed).toBe(false);
    expect(res4.remaining).toBe(0);
    expect(res4.retryAfterSec).toBeGreaterThanOrEqual(1);
    expect(res4.resetAt).toBeGreaterThan(0);
  });

  it('should evict entries older than sliding window boundary', async () => {
    const routeId = `test_eviction_${Date.now()}`;
    const now = 1000000;
    const windowSec = 10; // 10,000 ms

    // Inject request 1 at t = 1,000,000
    const res1 = await limiter.checkLimit({
      namespace: 'ip',
      identifier: '10.0.0.5',
      routeId,
      windowSec,
      limit: 2,
      nowMs: now,
    });
    expect(res1.allowed).toBe(true);
    expect(res1.remaining).toBe(1);

    // Inject request 2 at t = 1,005,000
    const res2 = await limiter.checkLimit({
      namespace: 'ip',
      identifier: '10.0.0.5',
      routeId,
      windowSec,
      limit: 2,
      nowMs: now + 5000,
    });
    expect(res2.allowed).toBe(true);
    expect(res2.remaining).toBe(0);

    // Inject request 3 at t = 1,008,000 (limit reached)
    const res3 = await limiter.checkLimit({
      namespace: 'ip',
      identifier: '10.0.0.5',
      routeId,
      windowSec,
      limit: 2,
      nowMs: now + 8000,
    });
    expect(res3.allowed).toBe(false);

    // At t = 1,010,001 (request 1 at 1,000,000 has expired; window is [1,000,001 to 1,010,001])
    const res4 = await limiter.checkLimit({
      namespace: 'ip',
      identifier: '10.0.0.5',
      routeId,
      windowSec,
      limit: 2,
      nowMs: now + 10001,
    });
    expect(res4.allowed).toBe(true);
    expect(res4.remaining).toBe(0); // 1 request still active (from 1,005,000) + 1 new
  });

  describe('Window Boundary Precision', () => {
    it('should evict an entry exactly at (now_ms - window_ms)', async () => {
      const routeId = `test_boundary_${Date.now()}`;
      const now = 2000000;
      const windowSec = 5; // 5000ms

      // Request 1 at t = 2,000,000
      await limiter.checkLimit({
        namespace: 'key',
        identifier: 'key_bound_1',
        routeId,
        windowSec,
        limit: 1,
        nowMs: now,
      });

      // Exactly at t = 2,005,000: (2,005,000 - 5000 = 2,000,000) -> 2,000,000 is <= 2,000,000 and thus evicted
      const res = await limiter.checkLimit({
        namespace: 'key',
        identifier: 'key_bound_1',
        routeId,
        windowSec,
        limit: 1,
        nowMs: now + 5000,
      });

      expect(res.allowed).toBe(true);
      expect(res.remaining).toBe(0);
    });

    it('should keep an entry strictly inside (now_ms - window_ms + 1)', async () => {
      const routeId = `test_inside_boundary_${Date.now()}`;
      const now = 3000000;
      const windowSec = 5;

      // Request 1 at t = 3,000,000
      await limiter.checkLimit({
        namespace: 'key',
        identifier: 'key_bound_2',
        routeId,
        windowSec,
        limit: 1,
        nowMs: now,
      });

      // At t = 3,004,999: (3,004,999 - 5000 = 2,999,999) -> 3,000,000 is still active
      const res = await limiter.checkLimit({
        namespace: 'key',
        identifier: 'key_bound_2',
        routeId,
        windowSec,
        limit: 1,
        nowMs: now + 4999,
      });

      expect(res.allowed).toBe(false);
      expect(res.remaining).toBe(0);
      expect(res.retryAfterSec).toBe(1);
    });
  });

  describe('NOSCRIPT & Script Recovery Handling', () => {
    it('should recover from script flush using automatic script reload', async () => {
      const routeId = `test_noscript_${Date.now()}`;

      // Flush Redis script cache
      await redis.rawClient.script('FLUSH');

      const res = await limiter.checkLimit({
        namespace: 'user',
        identifier: 'usr_noscript_01',
        routeId,
        windowSec: 60,
        limit: 5,
      });

      expect(res.allowed).toBe(true);
      expect(res.remaining).toBe(4);
    });
  });

  describe('Redis Failure Policy Handling', () => {
    it('should fail-open and return degraded allowed result when Redis is disconnected', async () => {
      const disconnectedRedis = createRedisClient({
        host: '127.0.0.1',
        port: 65530, // dead port
        connectTimeoutMs: 100,
        commandTimeoutMs: 100,
      });

      const failOpenLimiter = new SlidingWindowRateLimiter(disconnectedRedis, {
        failurePolicy: 'fail-open',
      });

      const res = await failOpenLimiter.checkLimit({
        namespace: 'ip',
        identifier: '10.0.0.1',
        routeId: 'route_fail_open',
        windowSec: 60,
        limit: 10,
      });

      expect(res.allowed).toBe(true);
      expect(res.degraded).toBe(true);
      expect(res.remaining).toBe(10);
      expect(res.limit).toBe(10);

      await disconnectedRedis.close();
    });

    it('should fail-closed and throw ServiceUnavailableError when Redis is disconnected', async () => {
      const disconnectedRedis = createRedisClient({
        host: '127.0.0.1',
        port: 65530,
        connectTimeoutMs: 100,
        commandTimeoutMs: 100,
      });

      const failClosedLimiter = new SlidingWindowRateLimiter(disconnectedRedis, {
        failurePolicy: 'fail-closed',
      });

      await expect(
        failClosedLimiter.checkLimit({
          namespace: 'ip',
          identifier: '10.0.0.1',
          routeId: 'route_fail_closed',
          windowSec: 60,
          limit: 10,
        })
      ).rejects.toThrow(ServiceUnavailableError);

      await disconnectedRedis.close();
    });
  });
});
