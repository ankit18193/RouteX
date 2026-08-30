import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { type FastifyInstance } from 'fastify';
import { request } from 'undici';
import { createGatewayServer, type RouteXGatewayServer } from '../../src/server/gateway-server.js';
import { buildUserService } from '../../mock-services/user-service/index.js';
import { generateTestJwt, TEST_JWT_SECRET, TEST_RSA_PUBLIC_KEY } from '../../mock-services/user-service/jwt-utils.js';
import type { GatewayConfigInput } from '../../src/types/index.js';
import { createRedisClient, type RedisClient } from '../../src/rate-limit/redis-client.js';

describe('RouteX Distributed Redis Rate Limiter Gateway Integration', () => {
  let userService: FastifyInstance;
  let userAddress: string;

  let redisClient: RedisClient;
  let gateway: RouteXGatewayServer;
  let gatewayAddress: string;

  const validApiKey = 'rx_live_client_ratelimit_123456789012';

  beforeAll(async () => {
    userService = buildUserService({ logger: false });
    userAddress = await userService.listen({ port: 0, host: '127.0.0.1' });

    redisClient = createRedisClient({
      host: '127.0.0.1',
      port: 6379,
      keyPrefix: 'gw_test:',
    });
    await redisClient.connect();

    const gatewayConfig: GatewayConfigInput = {
      server: {
        port: 8080,
        host: '127.0.0.1',
        requestTimeoutMs: 5000,
        headersTimeoutMs: 6000,
        maxHeaderSize: 16384,
        logLevel: 'silent',
        logFormat: 'json',
        trustedProxies: ['127.0.0.1'],
      },
      redis: {
        host: '127.0.0.1',
        port: 6379,
        keyPrefix: 'gw_test:',
        connectTimeoutMs: 1000,
      },
      auth: {
        jwt: {
          enabled: true,
          hs256Secret: TEST_JWT_SECRET,
          rs256PublicKey: TEST_RSA_PUBLIC_KEY,
        },
        apiKeys: {
          enabled: true,
          keys: [
            {
              id: 'key_ratelimit_01',
              key: validApiKey,
              userId: 'usr_api_ratelimit',
              roles: ['api:all'],
            },
          ],
        },
      },
      routes: [
        {
          id: 'route_ip_limited',
          pathPrefix: '/public/limited',
          upstream: `${userAddress}/api/v1/users/me`,
          methods: ['GET'],
          stripPrefix: true,
          auth: { mode: 'public' },
          rateLimit: {
            enabled: true,
            windowSec: 60,
            limit: 3,
            ipLimit: 3,
            failurePolicy: 'fail-open',
          },
          timeouts: { connectTimeoutMs: 1000, responseTimeoutMs: 3000 },
        },
        {
          id: 'route_tiered_jwt',
          pathPrefix: '/jwt/tiered',
          upstream: `${userAddress}/api/v1/users/me`,
          methods: ['GET'],
          stripPrefix: true,
          auth: { mode: 'jwt' },
          rateLimit: {
            enabled: true,
            windowSec: 60,
            limit: 10,
            ipLimit: 100,
            tiers: {
              free: 2,
              premium: 5,
            },
            failurePolicy: 'fail-open',
          },
          timeouts: { connectTimeoutMs: 1000, responseTimeoutMs: 3000 },
        },
        {
          id: 'route_apikey_limited',
          pathPrefix: '/apikey/limited',
          upstream: `${userAddress}/api/v1/users/me`,
          methods: ['GET'],
          stripPrefix: true,
          auth: { mode: 'api-key' },
          rateLimit: {
            enabled: true,
            windowSec: 60,
            limit: 3,
            failurePolicy: 'fail-open',
          },
          timeouts: { connectTimeoutMs: 1000, responseTimeoutMs: 3000 },
        },
      ],
    };

    gateway = createGatewayServer(gatewayConfig, {
      logger: false,
      redisClient,
    });
    await gateway.listen(0, '127.0.0.1');
    const port = (gateway.fastifyInstance.server.address() as any).port;
    gatewayAddress = `http://127.0.0.1:${port}`;
  });

  beforeEach(async () => {
    const keys = await redisClient.rawClient.keys('gw_test:*');
    if (keys.length > 0) {
      await redisClient.rawClient.del(...keys);
    }
  });

  afterAll(async () => {
    await gateway.close();
    await redisClient.close();
    await userService.close();
  });

  describe('Tier-1 IP Rate Limiting on Public Routes', () => {
    it('should expose X-RateLimit-* headers and reject when limit is exceeded with 429', async () => {
      // 1st request
      const res1 = await request(`${gatewayAddress}/public/limited`);
      expect(res1.statusCode).toBe(200);
      expect(res1.headers['x-ratelimit-limit']).toBe('3');
      expect(res1.headers['x-ratelimit-remaining']).toBe('2');
      expect(res1.headers['x-ratelimit-reset']).toBeDefined();

      // 2nd request
      const res2 = await request(`${gatewayAddress}/public/limited`);
      expect(res2.statusCode).toBe(200);
      expect(res2.headers['x-ratelimit-remaining']).toBe('1');

      // 3rd request (last allowed)
      const res3 = await request(`${gatewayAddress}/public/limited`);
      expect(res3.statusCode).toBe(200);
      expect(res3.headers['x-ratelimit-remaining']).toBe('0');

      // 4th request -> 429 Too Many Requests
      const res4 = await request(`${gatewayAddress}/public/limited`);
      expect(res4.statusCode).toBe(429);
      expect(res4.headers['x-ratelimit-remaining']).toBe('0');
      expect(res4.headers['retry-after']).toBeDefined();
      expect(Number(res4.headers['retry-after'])).toBeGreaterThanOrEqual(1);

      const body = (await res4.body.json()) as Record<string, unknown>;
      expect(body.error).toBe('TOO_MANY_REQUESTS');
      expect(body.requestId).toBeDefined();
    });
  });

  describe('Tier-2 Authenticated Identity Rate Limiting & Tier Overrides', () => {
    it('should enforce Free tier limit (2 requests/min) for free user', async () => {
      const freeToken = generateTestJwt({
        sub: 'usr_free_plan_01',
        customClaims: { tier: 'free' },
      });

      // Req 1 (Free)
      const res1 = await request(`${gatewayAddress}/jwt/tiered`, {
        headers: { authorization: `Bearer ${freeToken}` },
      });
      expect(res1.statusCode).toBe(200);
      expect(res1.headers['x-ratelimit-limit']).toBe('2');
      expect(res1.headers['x-ratelimit-remaining']).toBe('1');

      // Req 2 (Free)
      const res2 = await request(`${gatewayAddress}/jwt/tiered`, {
        headers: { authorization: `Bearer ${freeToken}` },
      });
      expect(res2.statusCode).toBe(200);
      expect(res2.headers['x-ratelimit-remaining']).toBe('0');

      // Req 3 (Free) -> 429
      const res3 = await request(`${gatewayAddress}/jwt/tiered`, {
        headers: { authorization: `Bearer ${freeToken}` },
      });
      expect(res3.statusCode).toBe(429);
      expect(res3.headers['retry-after']).toBeDefined();
    });

    it('should enforce Premium tier limit (5 requests/min) for premium user', async () => {
      const premiumToken = generateTestJwt({
        sub: 'usr_premium_plan_01',
        customClaims: { tier: 'premium' },
      });

      // 5 requests allowed
      for (let i = 0; i < 5; i++) {
        const res = await request(`${gatewayAddress}/jwt/tiered`, {
          headers: { authorization: `Bearer ${premiumToken}` },
        });
        expect(res.statusCode).toBe(200);
        expect(res.headers['x-ratelimit-limit']).toBe('5');
      }

      // 6th request -> 429
      const res6 = await request(`${gatewayAddress}/jwt/tiered`, {
        headers: { authorization: `Bearer ${premiumToken}` },
      });
      expect(res6.statusCode).toBe(429);
      expect(res6.headers['x-ratelimit-remaining']).toBe('0');
    });
  });

  describe('API Key Rate Limiting', () => {
    it('should enforce rate limits on API key authenticated requests', async () => {
      // 3 requests allowed
      for (let i = 0; i < 3; i++) {
        const res = await request(`${gatewayAddress}/apikey/limited`, {
          headers: { 'x-api-key': validApiKey },
        });
        expect(res.statusCode).toBe(200);
      }

      // 4th request -> 429
      const res4 = await request(`${gatewayAddress}/apikey/limited`, {
        headers: { 'x-api-key': validApiKey },
      });
      expect(res4.statusCode).toBe(429);
    });
  });
});
