import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { type FastifyInstance } from 'fastify';
import { request } from 'undici';
import http from 'node:http';
import { createGatewayServer, type RouteXGatewayServer } from '../../src/server/gateway-server.js';
import { buildUserService } from '../../mock-services/user-service/index.js';
import { buildChatService } from '../../mock-services/chat-service/index.js';
import type { GatewayConfigInput } from '../../src/types/index.js';

describe('RouteX Gateway Reverse Proxy Integration', () => {
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
      redis: {
        host: '127.0.0.1',
        port: 6379,
        db: 0,
        tls: false,
        connectTimeoutMs: 1000,
      },
      routes: [
        {
          id: 'user_service',
          pathPrefix: '/api/v1/users',
          upstream: userAddress,
          methods: ['GET', 'POST'],
          stripPrefix: false,
          auth: { mode: 'public', requiredRoles: [] },
          timeouts: { connectTimeoutMs: 1000, responseTimeoutMs: 3000 },
        },
        {
          id: 'chat_service',
          pathPrefix: '/api/v1/chats',
          upstream: chatAddress,
          methods: ['GET', 'POST'],
          stripPrefix: false,
          auth: { mode: 'public', requiredRoles: [] },
          timeouts: { connectTimeoutMs: 1000, responseTimeoutMs: 3000 },
        },
        {
          id: 'messages_service',
          pathPrefix: '/api/v1/messages',
          upstream: chatAddress,
          methods: ['POST'],
          stripPrefix: false,
          auth: { mode: 'public', requiredRoles: [] },
          timeouts: { connectTimeoutMs: 1000, responseTimeoutMs: 3000 },
        },
        {
          id: 'timeout_route',
          pathPrefix: '/test/slow',
          upstream: `${userAddress}/api/v1/users/slow`,
          methods: ['GET'],
          stripPrefix: true,
          auth: { mode: 'public', requiredRoles: [] },
          timeouts: { connectTimeoutMs: 500, responseTimeoutMs: 100 }, // 100ms timeout
        },
        {
          id: 'unreachable_route',
          pathPrefix: '/test/unreachable',
          upstream: 'http://127.0.0.1:49998',
          methods: ['GET'],
          stripPrefix: true,
          auth: { mode: 'public', requiredRoles: [] },
          timeouts: { connectTimeoutMs: 500, responseTimeoutMs: 1000 },
        },
      ],
    };

    gateway = createGatewayServer(gatewayConfig, { logger: false });
    gatewayAddress = await gateway.listen(0, '127.0.0.1');
  });

  afterAll(async () => {
    await gateway.close();
    await userService.close();
    await chatService.close();
  });

  describe('Gateway Self Health', () => {
    it('should return 200 on /gateway/healthz', async () => {
      const res = await request(`${gatewayAddress}/gateway/healthz`);
      expect(res.statusCode).toBe(200);
      const json = (await res.body.json()) as Record<string, unknown>;
      expect(json.status).toBe('ok');
      expect(json.gateway).toBe('RouteX');
    });
  });

  describe('Reverse Proxy Routing & Forwarding', () => {
    it('should proxy GET /api/v1/users/me and sanitize headers with dynamic token stripping', async () => {
      const parsedGateway = new URL(gatewayAddress);

      // Using raw node:http to test raw Connection header tokens explicitly
      const responseData = await new Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; body: Record<string, unknown> }>(
        (resolve, reject) => {
          const req = http.request(
            {
              hostname: parsedGateway.hostname,
              port: parsedGateway.port,
              path: '/api/v1/users/me',
              method: 'GET',
              headers: {
                'x-request-id': 'custom_req_001',
                'x-user-id': 'spoofed_admin_id', // Spoofed user header must be stripped
                'connection': 'close, X-Dynamic-Hop',
                'x-dynamic-hop': 'strip-me',
              },
            },
            (res) => {
              const chunks: Buffer[] = [];
              res.on('data', (c) => chunks.push(c));
              res.on('end', () => {
                const bodyStr = Buffer.concat(chunks).toString('utf-8');
                resolve({
                  statusCode: res.statusCode ?? 0,
                  headers: res.headers,
                  body: JSON.parse(bodyStr) as Record<string, unknown>,
                });
              });
            }
          );
          req.on('error', reject);
          req.end();
        }
      );

      expect(responseData.statusCode).toBe(200);
      expect(responseData.headers['x-request-id']).toBe('custom_req_001');

      const json = responseData.body;
      expect(json.service).toBe('user-service');
      // Spoofed user header must be stripped
      expect(json.userId).toBeNull();

      const receivedHeaders = json.receivedHeaders as Record<string, string>;
      expect(receivedHeaders['x-dynamic-hop']).toBeUndefined();
      expect(receivedHeaders['x-gateway-forwarded-by']).toBe('routex');
    });

    it('should proxy POST /api/v1/messages and receive 201 created', async () => {
      const res = await request(`${gatewayAddress}/api/v1/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-request-id': 'req_msg_post',
        },
        body: JSON.stringify({
          chatId: 'chat_alpha',
          content: 'Hello via RouteX gateway proxy!',
        }),
      });

      expect(res.statusCode).toBe(201);
      expect(res.headers['x-request-id']).toBe('req_msg_post');
      const json = (await res.body.json()) as Record<string, unknown>;
      expect(json.chatId).toBe('chat_alpha');
      expect(json.content).toBe('Hello via RouteX gateway proxy!');
    });

    it('should return 404 Route Not Found for unmatched paths', async () => {
      const res = await request(`${gatewayAddress}/non-existent/resource`, {
        headers: { 'x-request-id': 'req_404' },
      });

      expect(res.statusCode).toBe(404);
      expect(res.headers['x-request-id']).toBe('req_404');
      const json = (await res.body.json()) as Record<string, unknown>;
      expect(json.error).toBe('ROUTE_NOT_FOUND');
    });

    it('should return 405 Method Not Allowed with Allow header when method is forbidden', async () => {
      const res = await request(`${gatewayAddress}/api/v1/messages`, {
        method: 'GET', // messages_service only allows POST
        headers: { 'x-request-id': 'req_405' },
      });

      expect(res.statusCode).toBe(405);
      expect(res.headers['allow']).toContain('POST');
      expect(res.headers['x-request-id']).toBe('req_405');
      const json = (await res.body.json()) as Record<string, unknown>;
      expect(json.error).toBe('BAD_REQUEST');
    });
  });

  describe('Error Boundaries & Timeouts', () => {
    it('should return 504 Gateway Timeout when upstream response exceeds timeout limit', async () => {
      const res = await request(`${gatewayAddress}/test/slow?delayMs=500`, {
        headers: { 'x-request-id': 'req_timeout_test' },
      });

      expect(res.statusCode).toBe(504);
      expect(res.headers['x-request-id']).toBe('req_timeout_test');
      const json = (await res.body.json()) as Record<string, unknown>;
      expect(json.error).toBe('GATEWAY_TIMEOUT');
    });

    it('should return 502 Bad Gateway when upstream host is unreachable', async () => {
      const res = await request(`${gatewayAddress}/test/unreachable`, {
        headers: { 'x-request-id': 'req_unreachable_test' },
      });

      expect(res.statusCode).toBe(502);
      expect(res.headers['x-request-id']).toBe('req_unreachable_test');
      const json = (await res.body.json()) as Record<string, unknown>;
      expect(json.error).toBe('BAD_GATEWAY');
    });

    it('should forward upstream 500 status when upstream errors out', async () => {
      const res = await request(`${gatewayAddress}/api/v1/users/fault?type=500`, {
        headers: { 'x-request-id': 'req_upstream_500' },
      });

      expect(res.statusCode).toBe(500);
      expect(res.headers['x-request-id']).toBe('req_upstream_500');
    });
  });
});
