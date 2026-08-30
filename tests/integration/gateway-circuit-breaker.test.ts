import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { type FastifyInstance } from 'fastify';
import { request } from 'undici';
import { createGatewayServer, type RouteXGatewayServer } from '../../src/server/gateway-server.js';
import { buildUserService } from '../../mock-services/user-service/index.js';
import { buildChatService } from '../../mock-services/chat-service/index.js';
import type { GatewayConfigInput } from '../../src/types/index.js';

describe('RouteX Gateway Circuit Breaker Integration', () => {
  let userService: FastifyInstance;
  let chatService: FastifyInstance;
  let userAddress: string;
  let chatAddress: string;

  let gateway: RouteXGatewayServer;
  let gatewayAddress: string;

  beforeAll(async () => {
    userService = buildUserService({ logger: false });
    chatService = buildChatService({ logger: false });

    userAddress = await userService.listen({ port: 0, host: '127.0.0.1' });
    chatAddress = await chatService.listen({ port: 0, host: '127.0.0.1' });

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
      routes: [
        {
          id: 'route_cb_user',
          pathPrefix: '/cb/user',
          upstream: `${userAddress}/api/v1/users`,
          stripPrefix: true,
          methods: ['GET', 'POST'],
          auth: { mode: 'public' },
          circuitBreaker: {
            enabled: true,
            failureThreshold: 2,
            resetTimeoutMs: 150, // Fast reset for test
            halfOpenMaxRequests: 1,
            failureStatusCodes: [500, 502, 503, 504],
          },
        },
        {
          id: 'route_cb_chat',
          pathPrefix: '/cb/chat',
          upstream: `${chatAddress}/api/v1/chats`,
          stripPrefix: true,
          methods: ['GET', 'POST'],
          auth: { mode: 'public' },
          circuitBreaker: {
            enabled: true,
            failureThreshold: 2,
            resetTimeoutMs: 150,
            halfOpenMaxRequests: 1,
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

  afterAll(async () => {
    await gateway.close();
    await userService.close();
    await chatService.close();
  });

  it('should allow requests in CLOSED state', async () => {
    const res = await request(`${gatewayAddress}/cb/user/me`);
    expect(res.statusCode).toBe(200);
    await res.body.dump();
  });

  it('should transition to OPEN after failureThreshold is reached and reject with 503 error envelope', async () => {
    // 1st failure (500 from mock user service fault endpoint)
    const resFail1 = await request(`${gatewayAddress}/cb/user/fault?type=500`);
    expect(resFail1.statusCode).toBe(500);
    await resFail1.body.dump();

    // 2nd failure
    const resFail2 = await request(`${gatewayAddress}/cb/user/fault?type=500`);
    expect(resFail2.statusCode).toBe(500);
    await resFail2.body.dump();

    // Circuit should now be OPEN! Next request should immediately return 503 without contacting upstream
    const resOpen = await request(`${gatewayAddress}/cb/user/me`);
    expect(resOpen.statusCode).toBe(503);
    expect(resOpen.headers['retry-after']).toBeDefined();

    const envelope = (await resOpen.body.json()) as any;
    expect(envelope.error).toBe('UPSTREAM_CIRCUIT_OPEN');
    expect(envelope.statusCode).toBe(503);
  });

  it('should isolate circuit state between independent upstream origins', async () => {
    // User circuit is currently OPEN. Chat service circuit must be CLOSED.
    const resChat = await request(`${gatewayAddress}/cb/chat`);
    expect(resChat.statusCode).toBe(200);
    await resChat.body.dump();
  });

  it('should transition to HALF_OPEN after cooldown and recover to CLOSED on successful probe', async () => {
    // Wait for resetTimeoutMs (150ms)
    await new Promise((resolve) => setTimeout(resolve, 180));

    // Probe in HALF_OPEN -> should succeed
    const probeRes = await request(`${gatewayAddress}/cb/user/me`);
    expect(probeRes.statusCode).toBe(200);
    await probeRes.body.dump();

    // Subsequent request should now be in CLOSED state and succeed
    const afterProbeRes = await request(`${gatewayAddress}/cb/user/me`);
    expect(afterProbeRes.statusCode).toBe(200);
    await afterProbeRes.body.dump();
  });

  it('should re-open circuit if probe in HALF_OPEN fails', async () => {
    // Trip to OPEN
    await request(`${gatewayAddress}/cb/user/fault?type=500`);
    await request(`${gatewayAddress}/cb/user/fault?type=500`);

    // Verify OPEN
    const resOpen = await request(`${gatewayAddress}/cb/user/me`);
    expect(resOpen.statusCode).toBe(503);
    await resOpen.body.dump();

    // Wait for cooldown
    await new Promise((resolve) => setTimeout(resolve, 180));

    // Probe fails with 500
    const failProbe = await request(`${gatewayAddress}/cb/user/fault?type=500`);
    expect(failProbe.statusCode).toBe(500);
    await failProbe.body.dump();

    // Immediately OPEN again
    const resOpenAgain = await request(`${gatewayAddress}/cb/user/me`);
    expect(resOpenAgain.statusCode).toBe(503);
    await resOpenAgain.body.dump();
  });
});
