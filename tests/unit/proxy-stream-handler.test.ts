import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fastify, { type FastifyInstance } from 'fastify';
import { request } from 'undici';
import { UpstreamPoolManager } from '../../src/proxy/pool.js';
import { handleProxyStream } from '../../src/proxy/stream-handler.js';
import { buildUserService } from '../../mock-services/user-service/index.js';
import { buildChatService } from '../../mock-services/chat-service/index.js';
import type { RouteDefinition } from '../../src/types/index.js';

describe('handleProxyStream', () => {
  let userService: FastifyInstance;
  let chatService: FastifyInstance;
  let userAddress: string;
  let chatAddress: string;

  let gatewayApp: FastifyInstance;
  let gatewayAddress: string;
  let poolManager: UpstreamPoolManager;

  beforeAll(async () => {
    userService = buildUserService({ logger: false });
    chatService = buildChatService({ logger: false });

    userAddress = await userService.listen({ port: 0, host: '127.0.0.1' });
    chatAddress = await chatService.listen({ port: 0, host: '127.0.0.1' });

    poolManager = new UpstreamPoolManager();

    gatewayApp = fastify({ logger: false });

    // Allow raw stream payloads for octet-stream and buffer for generic payloads
    gatewayApp.addContentTypeParser('application/octet-stream', (_req, payload, done) => {
      done(null, payload);
    });
    gatewayApp.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, payload, done) => {
      done(null, payload);
    });

    const userRoute: RouteDefinition = {
      id: 'mock_user_service',
      pathPrefix: '/users',
      upstream: userAddress,
      methods: ['GET', 'POST'],
      stripPrefix: true,
      auth: { mode: 'public', requiredRoles: [] },
      timeouts: { connectTimeoutMs: 1000, responseTimeoutMs: 2000 },
    };

    const chatRoute: RouteDefinition = {
      id: 'mock_chat_service',
      pathPrefix: '/chats',
      upstream: chatAddress,
      methods: ['GET', 'POST'],
      stripPrefix: true,
      auth: { mode: 'public', requiredRoles: [] },
      timeouts: { connectTimeoutMs: 1000, responseTimeoutMs: 2000 },
    };

    const timeoutRoute: RouteDefinition = {
      id: 'mock_timeout_service',
      pathPrefix: '/timeout',
      upstream: userAddress,
      methods: ['GET'],
      stripPrefix: true,
      auth: { mode: 'public', requiredRoles: [] },
      timeouts: { connectTimeoutMs: 1000, responseTimeoutMs: 100 }, // 100ms timeout
    };

    const unreachableRoute: RouteDefinition = {
      id: 'mock_unreachable_service',
      pathPrefix: '/unreachable',
      upstream: 'http://127.0.0.1:49999', // Closed port
      methods: ['GET'],
      stripPrefix: true,
      auth: { mode: 'public', requiredRoles: [] },
      timeouts: { connectTimeoutMs: 500, responseTimeoutMs: 1000 },
    };

    gatewayApp.all('/users/*', async (req, reply) => {
      const remainingPath = req.url.replace(/^\/users/, '');
      const targetUrl = `${userAddress}${remainingPath}`;
      return handleProxyStream({
        req,
        reply,
        targetUrl,
        route: userRoute,
        poolManager,
        requestId: 'req_test_user_stream',
        startTime: process.hrtime.bigint(),
      });
    });

    gatewayApp.all('/chats/*', async (req, reply) => {
      const remainingPath = req.url.replace(/^\/chats/, '');
      const targetUrl = `${chatAddress}${remainingPath}`;
      return handleProxyStream({
        req,
        reply,
        targetUrl,
        route: chatRoute,
        poolManager,
        requestId: 'req_test_chat_stream',
        startTime: process.hrtime.bigint(),
      });
    });

    gatewayApp.all('/timeout/*', async (req, reply) => {
      const remainingPath = req.url.replace(/^\/timeout/, '');
      const targetUrl = `${userAddress}${remainingPath}`;
      return handleProxyStream({
        req,
        reply,
        targetUrl,
        route: timeoutRoute,
        poolManager,
        requestId: 'req_test_timeout_stream',
        startTime: process.hrtime.bigint(),
      });
    });

    gatewayApp.all('/unreachable/*', async (req, reply) => {
      const remainingPath = req.url.replace(/^\/unreachable/, '');
      const targetUrl = `http://127.0.0.1:49999${remainingPath}`;
      return handleProxyStream({
        req,
        reply,
        targetUrl,
        route: unreachableRoute,
        poolManager,
        requestId: 'req_test_unreachable',
        startTime: process.hrtime.bigint(),
      });
    });

    gatewayAddress = await gatewayApp.listen({ port: 0, host: '127.0.0.1' });
  });

  afterAll(async () => {
    await poolManager.close();
    await gatewayApp.close();
    await userService.close();
    await chatService.close();
  });

  it('should stream GET request to upstream and receive response', async () => {
    const res = await request(`${gatewayAddress}/users/healthz`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-request-id']).toBe('req_test_user_stream');
    const body = (await res.body.json()) as Record<string, unknown>;
    expect(body.status).toBe('ok');
    expect(body.service).toBe('user-service');
  });

  it('should stream POST request body to upstream and receive 201 response', async () => {
    const res = await request(`${gatewayAddress}/chats/api/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        chatId: 'chat_proxy_1',
        content: 'Proxied message via RouteX Stream Handler',
      }),
    });

    expect(res.statusCode).toBe(201);
    expect(res.headers['x-request-id']).toBe('req_test_chat_stream');
    const body = (await res.body.json()) as Record<string, unknown>;
    expect(body.chatId).toBe('chat_proxy_1');
    expect(body.content).toBe('Proxied message via RouteX Stream Handler');
  });

  it('should return 504 Gateway Timeout when upstream takes longer than responseTimeoutMs', async () => {
    const res = await request(`${gatewayAddress}/timeout/api/v1/users/slow?delayMs=500`);
    expect(res.statusCode).toBe(504);
    expect(res.headers['x-request-id']).toBe('req_test_timeout_stream');
    const body = (await res.body.json()) as Record<string, unknown>;
    expect(body.error).toBe('GATEWAY_TIMEOUT');
  });

  it('should return 502 Bad Gateway when upstream is completely unreachable', async () => {
    const res = await request(`${gatewayAddress}/unreachable/healthz`);
    expect(res.statusCode).toBe(502);
    expect(res.headers['x-request-id']).toBe('req_test_unreachable');
    const body = (await res.body.json()) as Record<string, unknown>;
    expect(body.error).toBe('BAD_GATEWAY');
  });
});
