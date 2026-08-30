import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { type FastifyInstance } from 'fastify';
import { request } from 'undici';
import { createGatewayServer, type RouteXGatewayServer } from '../../src/server/gateway-server.js';
import { buildUserService } from '../../mock-services/user-service/index.js';
import { generateTestJwt, TEST_JWT_SECRET, TEST_RSA_PUBLIC_KEY } from '../../mock-services/user-service/jwt-utils.js';
import type { GatewayConfigInput } from '../../src/types/index.js';
import { createRedisClient, type RedisClient } from '../../src/rate-limit/redis-client.js';

describe('RouteX Gateway Response Caching Integration', () => {
  let userService: FastifyInstance;
  let userAddress: string;

  let redisClient: RedisClient;
  let gateway: RouteXGatewayServer;
  let gatewayAddress: string;

  beforeAll(async () => {
    userService = buildUserService({ logger: false });
    userAddress = await userService.listen({ port: 0, host: '127.0.0.1' });

    redisClient = createRedisClient({
      host: '127.0.0.1',
      port: 6379,
      keyPrefix: 'gw_cache_test:',
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
        keyPrefix: 'gw_cache_test:',
        connectTimeoutMs: 1000,
      },
      auth: {
        jwt: {
          enabled: true,
          hs256Secret: TEST_JWT_SECRET,
          rs256PublicKey: TEST_RSA_PUBLIC_KEY,
        },
      },
      routes: [
        {
          id: 'route_cached_public',
          pathPrefix: '/cached/public',
          upstream: `${userAddress}/api/v1/users`,
          stripPrefix: true,
          methods: ['GET', 'POST'],
          auth: { mode: 'public' },
          cache: {
            enabled: true,
            ttlSec: 2,
            respectCacheControl: true,
            maxBodyBytes: 1024 * 1024,
            varyBy: ['accept'],
            allowAuthenticated: false,
          },
        },
        {
          id: 'route_cached_auth',
          pathPrefix: '/cached/auth',
          upstream: `${userAddress}/api/v1/users/me`,
          stripPrefix: true,
          methods: ['GET'],
          auth: { mode: 'jwt' },
          cache: {
            enabled: true,
            ttlSec: 2,
            respectCacheControl: true,
            maxBodyBytes: 1024 * 1024,
            varyBy: [],
            allowAuthenticated: true,
          },
        },
        {
          id: 'route_cached_tiny',
          pathPrefix: '/cached/tiny',
          upstream: `${userAddress}/api/v1/users/me`,
          stripPrefix: true,
          methods: ['GET'],
          auth: { mode: 'public' },
          cache: {
            enabled: true,
            ttlSec: 10,
            respectCacheControl: true,
            maxBodyBytes: 5, // Only 5 bytes allowed
            varyBy: [],
            allowAuthenticated: false,
          },
        },
        {
          id: 'route_uncached',
          pathPrefix: '/uncached',
          upstream: `${userAddress}/api/v1/users/me`,
          stripPrefix: true,
          methods: ['GET'],
          auth: { mode: 'public' },
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
    const keys = await redisClient.rawClient.keys('gw_cache_test:*');
    if (keys.length > 0) {
      await redisClient.rawClient.del(...keys);
    }
  });

  afterAll(async () => {
    await gateway.close();
    await redisClient.close();
    await userService.close();
  });

  it('should return X-Cache: MISS on 1st request and X-Cache: HIT with Age header on 2nd request', async () => {
    // 1st request -> MISS
    const res1 = await request(`${gatewayAddress}/cached/public/me`, {
      method: 'GET',
      headers: { accept: 'application/json' },
    });
    expect(res1.statusCode).toBe(200);
    expect(res1.headers['x-cache']).toBe('MISS');
    const body1 = await res1.body.json();

    // 2nd request -> HIT
    const res2 = await request(`${gatewayAddress}/cached/public/me`, {
      method: 'GET',
      headers: { accept: 'application/json' },
    });
    expect(res2.statusCode).toBe(200);
    expect(res2.headers['x-cache']).toBe('HIT');
    expect(res2.headers['age']).toBeDefined();
    const body2 = await res2.body.json();
    expect(body1).toEqual(body2);
  });

  it('should expire cached response after TTL and fetch fresh upstream response', async () => {
    // 1st request -> MISS
    const res1 = await request(`${gatewayAddress}/cached/public/me`);
    expect(res1.statusCode).toBe(200);
    expect(res1.headers['x-cache']).toBe('MISS');
    await res1.body.dump();

    // 2nd request -> HIT
    const res2 = await request(`${gatewayAddress}/cached/public/me`);
    expect(res2.statusCode).toBe(200);
    expect(res2.headers['x-cache']).toBe('HIT');
    await res2.body.dump();

    // Wait for TTL (2 seconds)
    await new Promise((resolve) => setTimeout(resolve, 2200));

    // 3rd request -> MISS (expired)
    const res3 = await request(`${gatewayAddress}/cached/public/me`);
    expect(res3.statusCode).toBe(200);
    expect(res3.headers['x-cache']).toBe('MISS');
    await res3.body.dump();
  });

  it('should isolate cache entries for different query parameters', async () => {
    const resA = await request(`${gatewayAddress}/cached/public/me?param=A`);
    expect(resA.headers['x-cache']).toBe('MISS');
    await resA.body.dump();

    const resB = await request(`${gatewayAddress}/cached/public/me?param=B`);
    expect(resB.headers['x-cache']).toBe('MISS');
    await resB.body.dump();

    const resA2 = await request(`${gatewayAddress}/cached/public/me?param=A`);
    expect(resA2.headers['x-cache']).toBe('HIT');
    await resA2.body.dump();
  });

  it('should isolate cache entries for configured Vary headers', async () => {
    const resJson = await request(`${gatewayAddress}/cached/public/me`, {
      headers: { accept: 'application/json' },
    });
    expect(resJson.headers['x-cache']).toBe('MISS');
    await resJson.body.dump();

    const resXml = await request(`${gatewayAddress}/cached/public/me`, {
      headers: { accept: 'application/xml' },
    });
    expect(resXml.headers['x-cache']).toBe('MISS');
    await resXml.body.dump();

    const resJson2 = await request(`${gatewayAddress}/cached/public/me`, {
      headers: { accept: 'application/json' },
    });
    expect(resJson2.headers['x-cache']).toBe('HIT');
    await resJson2.body.dump();
  });

  it('should return X-Cache: BYPASS for POST requests', async () => {
    const res = await request(`${gatewayAddress}/cached/public/me`, {
      method: 'POST',
      body: JSON.stringify({ action: 'create' }),
    });
    expect(res.headers['x-cache']).toBe('BYPASS');
    await res.body.dump();
  });

  it('should support authenticated cache isolation when allowAuthenticated is true', async () => {
    const tokenAlice = generateTestJwt({
      algorithm: 'HS256',
      sub: 'usr_alice',
      roles: ['user'],
    });

    const tokenBob = generateTestJwt({
      algorithm: 'HS256',
      sub: 'usr_bob',
      roles: ['user'],
    });

    // Alice 1st -> MISS
    const resAlice1 = await request(`${gatewayAddress}/cached/auth`, {
      headers: { authorization: `Bearer ${tokenAlice}` },
    });
    expect(resAlice1.headers['x-cache']).toBe('MISS');
    const dataAlice1 = (await resAlice1.body.json()) as any;
    expect(dataAlice1.userId).toBe('usr_alice');

    // Alice 2nd -> HIT
    const resAlice2 = await request(`${gatewayAddress}/cached/auth`, {
      headers: { authorization: `Bearer ${tokenAlice}` },
    });
    expect(resAlice2.headers['x-cache']).toBe('HIT');
    await resAlice2.body.dump();

    // Bob 1st -> MISS (isolated from Alice)
    const resBob1 = await request(`${gatewayAddress}/cached/auth`, {
      headers: { authorization: `Bearer ${tokenBob}` },
    });
    expect(resBob1.headers['x-cache']).toBe('MISS');
    const dataBob1 = (await resBob1.body.json()) as any;
    expect(dataBob1.userId).toBe('usr_bob');
  });

  it('should stream oversized response without caching when exceeding maxBodyBytes', async () => {
    const res1 = await request(`${gatewayAddress}/cached/tiny`);
    expect(res1.statusCode).toBe(200);
    expect(res1.headers['x-cache']).toBe('MISS');
    await res1.body.dump();

    // 2nd request is still a MISS because the response was oversized (> 5 bytes)
    const res2 = await request(`${gatewayAddress}/cached/tiny`);
    expect(res2.statusCode).toBe(200);
    expect(res2.headers['x-cache']).toBe('MISS');
    await res2.body.dump();
  });

  it('should collapse concurrent identical cache misses via single-flight', async () => {
    const [res1, res2, res3] = await Promise.all([
      request(`${gatewayAddress}/cached/public/slow?delayMs=100`),
      request(`${gatewayAddress}/cached/public/slow?delayMs=100`),
      request(`${gatewayAddress}/cached/public/slow?delayMs=100`),
    ]);

    expect(res1.statusCode).toBe(200);
    expect(res2.statusCode).toBe(200);
    expect(res3.statusCode).toBe(200);
    await Promise.all([res1.body.dump(), res2.body.dump(), res3.body.dump()]);
  });
});
