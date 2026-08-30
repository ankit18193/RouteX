import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { request } from 'undici';
import { createGatewayServer, type RouteXGatewayServer } from '../../src/server/gateway-server.js';
import type { GatewayConfigInput } from '../../src/types/index.js';
import { createRedisClient, type RedisClient } from '../../src/rate-limit/redis-client.js';

describe('Gateway Health, Readiness & Lifecycle Probes', () => {
  let redisClient: RedisClient;
  let gateway: RouteXGatewayServer;
  let gatewayAddress: string;

  beforeAll(async () => {
    redisClient = createRedisClient({
      host: '127.0.0.1',
      port: 6379,
      keyPrefix: 'health_test:',
    });
    await redisClient.connect();

    const config: GatewayConfigInput = {
      server: {
        port: 8080,
        host: '127.0.0.1',
        logLevel: 'silent',
        logFormat: 'json',
      },
      redis: {
        host: '127.0.0.1',
        port: 6379,
        keyPrefix: 'health_test:',
      },
      routes: [
        {
          id: 'test_health_route',
          pathPrefix: '/test',
          upstream: 'http://127.0.0.1:9999',
        },
      ],
    };

    gateway = createGatewayServer(config, {
      logger: false,
      redisClient,
    });
    await gateway.listen(0, '127.0.0.1');
    const port = (gateway.fastifyInstance.server.address() as any).port;
    gatewayAddress = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    try {
      await gateway.close();
    } catch {
      // Ignored
    }
    try {
      await redisClient.close();
    } catch {
      // Ignored
    }
  });

  it('should return 200 OK from /healthz liveness probe with runtime diagnostics', async () => {
    const res = await request(`${gatewayAddress}/healthz`);
    expect(res.statusCode).toBe(200);

    const body = (await res.body.json()) as any;
    expect(body.status).toBe('ok');
    expect(body.gateway).toBe('RouteX');
    expect(body.version).toBe('0.1.0');
    expect(body.uptimeSec).toBeGreaterThanOrEqual(0);
    expect(body.memory).toBeDefined();
    expect(typeof body.memory.heapUsed).toBe('number');
  });

  it('should return 200 OK from /livez endpoint', async () => {
    const res = await request(`${gatewayAddress}/livez`);
    expect(res.statusCode).toBe(200);

    const body = (await res.body.json()) as any;
    expect(body.status).toBe('ok');
    expect(body.gateway).toBe('RouteX');
  });

  it('should return 200 OK from /readyz endpoint when Redis and components are healthy', async () => {
    const res = await request(`${gatewayAddress}/readyz`);
    expect(res.statusCode).toBe(200);

    const body = (await res.body.json()) as any;
    expect(body.status).toBe('ok');
    expect(body.gateway).toBe('RouteX');
    expect(body.checks).toEqual({
      router: 'ok',
      poolManager: 'ok',
      redis: 'ok',
    });
  });

  it('should return 503 from /readyz when Redis ping fails', async () => {
    // Create an unready gateway pointing to a closed Redis connection
    const unreadyRedis = createRedisClient({
      host: '127.0.0.1',
      port: 59999, // Non-existent port
      connectTimeoutMs: 100,
    });

    const unreadyGateway = createGatewayServer(
      {
        server: { port: 8080, host: '127.0.0.1', logLevel: 'silent' },
        redis: { host: '127.0.0.1', port: 59999, connectTimeoutMs: 100 },
        routes: [{ id: 'test_r', pathPrefix: '/t', upstream: 'http://localhost:9999' }],
      },
      { logger: false, redisClient: unreadyRedis }
    );

    const address = await unreadyGateway.listen(0, '127.0.0.1');

    const res = await request(`${address}/readyz`);
    expect(res.statusCode).toBe(503);

    const body = (await res.body.json()) as any;
    expect(body.status).toBe('not_ready');
    expect(body.checks.redis).toBe('down');

    await unreadyGateway.close();
  });
});
