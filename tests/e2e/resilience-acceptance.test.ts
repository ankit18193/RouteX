import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { type FastifyInstance } from 'fastify';
import { request } from 'undici';
import { createGatewayServer, type RouteXGatewayServer } from '../../src/server/gateway-server.js';
import { buildUserService } from '../../mock-services/user-service/index.js';
import { buildChatService } from '../../mock-services/chat-service/index.js';
import { generateTestJwt, TEST_JWT_SECRET } from '../../mock-services/user-service/jwt-utils.js';
import { createRedisClient, type RedisClient } from '../../src/rate-limit/redis-client.js';
import type { GatewayConfigInput } from '../../src/types/index.js';

describe('RouteX E2E Acceptance — Distributed Resilience, Caching, SingleFlight & Circuit Breaker', () => {
  let userService: FastifyInstance;
  let chatService: FastifyInstance;
  let userAddress: string;
  let chatAddress: string;

  let testRedisClient: RedisClient;
  let gateway: RouteXGatewayServer;
  let gatewayAddress: string;

  beforeAll(async () => {
    userService = buildUserService({ logger: false });
    chatService = buildChatService({ logger: false });

    userAddress = await userService.listen({ port: 0, host: '127.0.0.1' });
    chatAddress = await chatService.listen({ port: 0, host: '127.0.0.1' });

    testRedisClient = createRedisClient({
      host: '127.0.0.1',
      port: 6379,
      db: 0,
      connectTimeoutMs: 2000,
    });
    await testRedisClient.connect();

    const gatewayConfig: GatewayConfigInput = {
      server: {
        port: 8080,
        host: '127.0.0.1',
        requestTimeoutMs: 15000,
        headersTimeoutMs: 16000,
        maxHeaderSize: 16384,
        logLevel: 'silent',
        logFormat: 'json',
        trustedProxies: ['127.0.0.1'],
      },
      redis: {
        host: '127.0.0.1',
        port: 6379,
        db: 0,
        tls: false,
        keyPrefix: 'routex:e2e:resilience:',
      },
      auth: {
        jwt: {
          enabled: true,
          hs256Secret: TEST_JWT_SECRET,
        },
        apiKeys: {
          enabled: true,
          keys: [
            {
              id: 'key_resilience_01',
              key: 'rx_live_resilience_test_key_123',
              userId: 'usr_resilience_key',
              roles: ['user'],
            },
          ],
        },
      },
      routes: [
        {
          id: 'route_cached_chats',
          pathPrefix: '/api/v1/resilience/chats',
          upstream: `${chatAddress}/api/v1/chats`,
          stripPrefix: true,
          methods: ['GET'],
          auth: { mode: 'public' },
          cache: {
            enabled: true,
            ttlSec: 2,
            maxBodyBytes: 1048576,
          },
        },
        {
          id: 'route_limited_ip',
          pathPrefix: '/api/v1/resilience/limited-ip',
          upstream: `${userAddress}/healthz`,
          stripPrefix: true,
          methods: ['GET'],
          auth: { mode: 'public' },
          rateLimit: {
            enabled: true,
            windowSec: 60,
            limit: 5,
            failurePolicy: 'fail-open',
          },
        },
        {
          id: 'route_limited_user',
          pathPrefix: '/api/v1/resilience/limited-user',
          upstream: `${userAddress}/healthz`,
          stripPrefix: true,
          methods: ['GET'],
          auth: { mode: 'jwt' },
          rateLimit: {
            enabled: true,
            windowSec: 60,
            limit: 4,
            ipLimit: 100,
            failurePolicy: 'fail-open',
          },
        },
        {
          id: 'route_breaker_user',
          pathPrefix: '/api/v1/resilience/breaker-user',
          upstream: `${userAddress}/api/v1/users`,
          stripPrefix: true,
          methods: ['GET', 'POST'],
          auth: { mode: 'public' },
          circuitBreaker: {
            enabled: true,
            failureThreshold: 3,
            resetTimeoutMs: 1000,
            failureStatusCodes: [500, 502, 503, 504],
          },
        },
        {
          id: 'route_breaker_chat',
          pathPrefix: '/api/v1/resilience/breaker-chat',
          upstream: `${chatAddress}/api/v1/chats`,
          stripPrefix: true,
          methods: ['GET'],
          auth: { mode: 'public' },
          circuitBreaker: {
            enabled: true,
            failureThreshold: 3,
            resetTimeoutMs: 1000,
            failureStatusCodes: [500, 502, 503, 504],
          },
        },
      ],
    };

    gateway = createGatewayServer(gatewayConfig, { logger: false });
    await gateway.listen(0, '127.0.0.1');
    const port = (gateway.fastifyInstance.server.address() as any).port;
    gatewayAddress = `http://127.0.0.1:${port}`;
  });

  beforeEach(async () => {
    await testRedisClient.rawClient.flushdb();
    gateway.circuitManager.resetAll();
  });

  afterAll(async () => {
    try {
      await gateway.close();
      await userService.close();
      await chatService.close();
      await testRedisClient.close();
    } catch {
      // Ignored
    }
  });

  // ============================================================================
  // 1. DISTRIBUTED RATE LIMITING ACCEPTANCE
  // ============================================================================
  describe('Distributed Rate Limiting Acceptance', () => {
    it('should enforce Tier-1 IP rate limits, set rate limit headers, and return 429 when exhausted', async () => {
      // Limit is 5 requests per 60s
      for (let i = 1; i <= 5; i++) {
        const res = await request(`${gatewayAddress}/api/v1/resilience/limited-ip`);
        expect(res.statusCode).toBe(200);
        expect(res.headers['x-ratelimit-limit']).toBe('5');
        expect(res.headers['x-ratelimit-remaining']).toBe(String(5 - i));
        expect(res.headers['x-ratelimit-reset']).toBeDefined();
        await res.body.dump();
      }

      // 6th request should hit 429 Rate Limit Exceeded
      const resExceeded = await request(`${gatewayAddress}/api/v1/resilience/limited-ip`);
      expect(resExceeded.statusCode).toBe(429);
      expect(resExceeded.headers['retry-after']).toBeDefined();
      expect(resExceeded.headers['x-ratelimit-remaining']).toBe('0');

      const body = (await resExceeded.body.json()) as any;
      expect(body.error).toBe('TOO_MANY_REQUESTS');
      expect(body.statusCode).toBe(429);
    });

    it('should enforce Tier-2 authenticated JWT user limits per user identity', async () => {
      const userTokenA = generateTestJwt({ sub: 'usr_rl_alice' });
      const userTokenB = generateTestJwt({ sub: 'usr_rl_bob' });

      // User A makes 4 requests (hits limit of 4)
      for (let i = 1; i <= 4; i++) {
        const resA = await request(`${gatewayAddress}/api/v1/resilience/limited-user`, {
          headers: { authorization: `Bearer ${userTokenA}` },
        });
        expect(resA.statusCode).toBe(200);
        await resA.body.dump();
      }

      // User A 5th request is 429
      const resAExceeded = await request(`${gatewayAddress}/api/v1/resilience/limited-user`, {
        headers: { authorization: `Bearer ${userTokenA}` },
      });
      expect(resAExceeded.statusCode).toBe(429);
      await resAExceeded.body.dump();

      // User B should still have full quota (User A limit does not bleed to User B)
      const resB = await request(`${gatewayAddress}/api/v1/resilience/limited-user`, {
        headers: { authorization: `Bearer ${userTokenB}` },
      });
      expect(resB.statusCode).toBe(200);
      expect(resB.headers['x-ratelimit-remaining']).toBe('3');
      await resB.body.dump();
    });
  });

  // ============================================================================
  // 2. RESPONSE CACHING ACCEPTANCE
  // ============================================================================
  describe('Distributed Response Caching Acceptance', () => {
    it('should return MISS on first request, HIT on second request, and canonicalize query params', async () => {
      // 1. First request -> MISS
      const res1 = await request(`${gatewayAddress}/api/v1/resilience/chats?sort=asc&page=1`);
      expect(res1.statusCode).toBe(200);
      expect(res1.headers['x-cache']).toBe('MISS');
      const body1 = (await res1.body.json()) as any;

      // 2. Second request with identical URL -> HIT
      const res2 = await request(`${gatewayAddress}/api/v1/resilience/chats?sort=asc&page=1`);
      expect(res2.statusCode).toBe(200);
      expect(res2.headers['x-cache']).toBe('HIT');
      const body2 = (await res2.body.json()) as any;
      expect(body2).toEqual(body1);

      // 3. Third request with reordered query parameters (?page=1&sort=asc) -> HIT (canonical key)
      const res3 = await request(`${gatewayAddress}/api/v1/resilience/chats?page=1&sort=asc`);
      expect(res3.statusCode).toBe(200);
      expect(res3.headers['x-cache']).toBe('HIT');
      await res3.body.dump();
    });

    it('should expire cached response after TTL (2 seconds) and fetch fresh MISS', async () => {
      const res1 = await request(`${gatewayAddress}/api/v1/resilience/chats`);
      expect(res1.statusCode).toBe(200);
      expect(res1.headers['x-cache']).toBe('MISS');
      await res1.body.dump();

      const res2 = await request(`${gatewayAddress}/api/v1/resilience/chats`);
      expect(res2.headers['x-cache']).toBe('HIT');
      await res2.body.dump();

      // Wait 2.2 seconds for TTL expiry
      await new Promise((resolve) => setTimeout(resolve, 2200));

      const res3 = await request(`${gatewayAddress}/api/v1/resilience/chats`);
      expect(res3.headers['x-cache']).toBe('MISS');
      await res3.body.dump();
    });
  });

  // ============================================================================
  // 3. SINGLEFLIGHT CACHE STAMPEDE PROTECTION ACCEPTANCE
  // ============================================================================
  describe('SingleFlight Cache Stampede Protection Acceptance', () => {
    it('should collapse 50 concurrent requests for an uncached resource into a single upstream fetch', async () => {
      // 50 concurrent requests simultaneously requesting the same uncached path
      const promises = Array.from({ length: 50 }, () =>
        request(`${gatewayAddress}/api/v1/resilience/chats?stampede=true`)
      );

      const responses = await Promise.all(promises);

      // All 50 responses MUST be 200 OK
      for (const res of responses) {
        expect(res.statusCode).toBe(200);
        await res.body.dump();
      }

      // Exactly 1 response is MISS (the leader) and the rest are SingleFlight followers
      const missCount = responses.filter((r) => r.headers['x-cache'] === 'MISS').length;
      expect(missCount).toBe(1);
    });
  });

  // ============================================================================
  // 4. PER-ORIGIN CIRCUIT BREAKER ACCEPTANCE
  // ============================================================================
  describe('Per-Origin Circuit Breaker Acceptance', () => {
    it('should trip circuit breaker to OPEN upon consecutive 5xx errors, fast-fail with 503, and isolate other origins', async () => {
      // 1. Trigger 3 consecutive 500 errors on User Service (/api/v1/users/fault?type=500)
      for (let i = 0; i < 3; i++) {
        const resFault = await request(
          `${gatewayAddress}/api/v1/resilience/breaker-user/fault?type=500`
        );
        expect(resFault.statusCode).toBe(500);
        await resFault.body.dump();
      }

      // 2. Circuit for User Service is now OPEN -> Next request immediately fast-fails with 503 UPSTREAM_CIRCUIT_OPEN
      const resTripped = await request(
        `${gatewayAddress}/api/v1/resilience/breaker-user/me`
      );
      expect(resTripped.statusCode).toBe(503);
      expect(resTripped.headers['retry-after']).toBeDefined();

      const bodyTripped = (await resTripped.body.json()) as any;
      expect(bodyTripped.error).toBe('UPSTREAM_CIRCUIT_OPEN');
      expect(bodyTripped.message).toContain('Upstream circuit breaker is OPEN');

      // 3. Origin Isolation: Chat Service circuit breaker MUST remain CLOSED (healthy)
      const resChat = await request(
        `${gatewayAddress}/api/v1/resilience/breaker-chat`
      );
      expect(resChat.statusCode).toBe(200);
      await resChat.body.dump();

      // 4. Wait recovery time (1.2 seconds) for transition to HALF_OPEN probe
      await new Promise((resolve) => setTimeout(resolve, 1200));

      // 5. Probe request succeeds -> transitions back to CLOSED
      const resRecovered = await request(
        `${gatewayAddress}/api/v1/resilience/breaker-user/me`,
        {
          headers: {
            authorization: `Bearer ${generateTestJwt({ sub: 'usr_probe' })}`,
          },
        }
      );
      expect(resRecovered.statusCode).toBe(200);
      await resRecovered.body.dump();
    });
  });
});
