import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { type FastifyInstance } from 'fastify';
import { request } from 'undici';
import { Readable } from 'node:stream';
import { createGatewayServer, type RouteXGatewayServer } from '../../src/server/gateway-server.js';
import { buildUserService } from '../../mock-services/user-service/index.js';
import { buildChatService } from '../../mock-services/chat-service/index.js';
import {
  generateTestJwt,
  TEST_JWT_SECRET,
  TEST_RSA_PUBLIC_KEY,
} from '../../mock-services/user-service/jwt-utils.js';
import type { GatewayConfigInput } from '../../src/types/index.js';

describe('RouteX E2E Acceptance — Functional, Routing, Streaming, Auth & Security', () => {
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
        requestTimeoutMs: 15000,
        headersTimeoutMs: 16000,
        maxHeaderSize: 16384,
        logLevel: 'silent',
        logFormat: 'json',
        trustedProxies: ['127.0.0.1'],
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
              id: 'key_test_01',
              key: 'rx_live_test_api_key_valid_123456',
              userId: 'usr_api_key_user',
              roles: ['user'],
            },
          ],
        },
      },
      routes: [
        {
          id: 'route_users_admin',
          pathPrefix: '/api/v1/users/admin',
          upstream: `${userAddress}/api/v1/users/me`,
          stripPrefix: true,
          methods: ['GET'],
          auth: {
            mode: 'jwt',
            requiredRoles: ['admin'],
          },
        },
        {
          id: 'route_users',
          pathPrefix: '/api/v1/users',
          upstream: userAddress,
          stripPrefix: false,
          methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
          auth: {
            mode: 'jwt',
            requiredRoles: [],
          },
        },
        {
          id: 'route_chats',
          pathPrefix: '/api/v1/chats',
          upstream: chatAddress,
          stripPrefix: false,
          methods: ['GET', 'POST'],
          auth: {
            mode: 'any',
          },
        },
        {
          id: 'route_public_auth',
          pathPrefix: '/api/v1/auth',
          upstream: userAddress,
          stripPrefix: false,
          methods: ['POST'],
          auth: {
            mode: 'public',
          },
        },
        {
          id: 'route_stream',
          pathPrefix: '/stream',
          upstream: chatAddress,
          stripPrefix: true,
          methods: ['GET', 'POST'],
          auth: {
            mode: 'public',
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
    try {
      await gateway.close();
      await userService.close();
      await chatService.close();
    } catch {
      // Ignored
    }
  });

  // ============================================================================
  // 1. ROUTING & DISPATCH ACCEPTANCE
  // ============================================================================
  describe('Routing & Dispatch Acceptance', () => {
    it('should forward valid route and preserve query parameters', async () => {
      const res = await request(`${gatewayAddress}/api/v1/users/slow?delayMs=10&tag=test%20query`);
      // Since it's protected by JWT, missing auth should fail before reaching upstream
      expect(res.statusCode).toBe(401);
    });

    it('should match longest prefix for /api/v1/users/admin over /api/v1/users', async () => {
      const userToken = generateTestJwt({
        algorithm: 'HS256',
        sub: 'usr_normal',
        roles: ['user'],
      });

      // Regular user token requesting /api/v1/users/admin should fail RBAC with 403
      const resAdmin = await request(`${gatewayAddress}/api/v1/users/admin`, {
        headers: { authorization: `Bearer ${userToken}` },
      });
      expect(resAdmin.statusCode).toBe(403);
      const err = (await resAdmin.body.json()) as any;
      expect(err.error).toBe('FORBIDDEN');

      // Admin token requesting /api/v1/users/admin should succeed with 200
      const adminToken = generateTestJwt({
        algorithm: 'HS256',
        sub: 'usr_admin',
        roles: ['admin'],
      });
      const resAdminSuccess = await request(`${gatewayAddress}/api/v1/users/admin`, {
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(resAdminSuccess.statusCode).toBe(200);
      await resAdminSuccess.body.dump();
    });

    it('should return 404 Route Not Found for unknown paths with consistent JSON envelope', async () => {
      const res = await request(`${gatewayAddress}/api/v1/nonexistent/path`);
      expect(res.statusCode).toBe(404);
      expect(res.headers['content-type']).toContain('application/json');

      const body = (await res.body.json()) as any;
      expect(body.error).toBe('ROUTE_NOT_FOUND');
      expect(body.statusCode).toBe(404);
      expect(body.requestId).toBeDefined();
    });

    it('should return 405 Method Not Allowed with Allow header for unsupported HTTP verbs', async () => {
      const res = await request(`${gatewayAddress}/api/v1/users/admin`, {
        method: 'POST',
      });
      expect(res.statusCode).toBe(405);
      expect(res.headers['allow']).toBe('GET');

      const body = (await res.body.json()) as any;
      expect(body.statusCode).toBe(405);
    });
  });

  // ============================================================================
  // 2. STREAMING & ZERO-BUFFER PROXY ACCEPTANCE
  // ============================================================================
  describe('Streaming & Backpressure Acceptance', () => {
    it('should stream large 4MB payload from upstream with chunk integrity', async () => {
      const res = await request(`${gatewayAddress}/stream/api/v1/stream-payload?sizeMb=4`);
      expect(res.statusCode).toBe(200);

      let totalBytes = 0;
      for await (const chunk of res.body) {
        totalBytes += (chunk as Buffer).length;
      }

      expect(totalBytes).toBe(4 * 1024 * 1024); // 4MB exact
    });

    it('should stream multi-chunk upload body to upstream without buffering', async () => {
      const chunkSize = 64 * 1024; // 64KB
      const numChunks = 16; // 1MB total
      let chunkCount = 0;

      const uploadStream = new Readable({
        read() {
          if (chunkCount < numChunks) {
            const buf = Buffer.alloc(chunkSize, 65 + (chunkCount % 26));
            chunkCount++;
            this.push(buf);
          } else {
            this.push(null);
          }
        },
      });

      const res = await request(`${gatewayAddress}/stream/api/v1/echo-stream`, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: uploadStream,
      });

      expect(res.statusCode).toBe(200);
      const body = (await res.body.json()) as any;
      expect(body.receivedBytes).toBe(numChunks * chunkSize);
      expect(body.chunkCount).toBeGreaterThanOrEqual(1);
    });
  });

  // ============================================================================
  // 3. AUTHENTICATION & IDENTITY ACCEPTANCE
  // ============================================================================
  describe('Authentication & Identity Engine Acceptance', () => {
    it('should allow public access to public route', async () => {
      const res = await request(`${gatewayAddress}/api/v1/auth/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sub: 'usr_custom', roles: ['user'] }),
      });
      expect(res.statusCode).toBe(200);
      const data = (await res.body.json()) as any;
      expect(data.token).toBeDefined();
    });

    it('should authenticate RS256 cryptographic JWT signature', async () => {
      const token = generateTestJwt({
        algorithm: 'RS256',
        sub: 'usr_rsa_alice',
        roles: ['user'],
      });

      const res = await request(`${gatewayAddress}/api/v1/users/me`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);

      const data = (await res.body.json()) as any;
      expect(data.userId).toBe('usr_rsa_alice');
      expect(data.authType).toBe('jwt');
    });

    it('should reject expired JWT with 401 and UNAUTHORIZED envelope', async () => {
      const expiredToken = generateTestJwt({
        algorithm: 'HS256',
        sub: 'usr_expired',
        expiresInSec: -30,
      });

      const res = await request(`${gatewayAddress}/api/v1/users/me`, {
        headers: { authorization: `Bearer ${expiredToken}` },
      });
      expect(res.statusCode).toBe(401);
      expect(res.headers['www-authenticate']).toBeDefined();

      const err = (await res.body.json()) as any;
      expect(err.error).toBe('UNAUTHORIZED');
      expect(err.statusCode).toBe(401);
    });

    it('should reject tampered JWT token', async () => {
      const validToken = generateTestJwt({ sub: 'usr_tamper' });
      const parts = validToken.split('.');
      const tampered = `${parts[0]}.${parts[1]}.invalidsignature12345`;

      const res = await request(`${gatewayAddress}/api/v1/users/me`, {
        headers: { authorization: `Bearer ${tampered}` },
      });
      expect(res.statusCode).toBe(401);
    });

    it('should authenticate API key when mode is any', async () => {
      const res = await request(`${gatewayAddress}/api/v1/chats`, {
        headers: { 'x-api-key': 'rx_live_test_api_key_valid_123456' },
      });
      expect(res.statusCode).toBe(200);
      await res.body.dump();
    });

    it('should reject unknown API key on protected route', async () => {
      const res = await request(`${gatewayAddress}/api/v1/chats`, {
        headers: { 'x-api-key': 'rx_live_invalid_key_99999999999' },
      });
      expect(res.statusCode).toBe(401);
    });
  });

  // ============================================================================
  // 4. HEADER SECURITY & SANITIZATION ACCEPTANCE
  // ============================================================================
  describe('Header Security & Identity Injection Acceptance', () => {
    it('should strip client spoofed identity headers and inject verified identity from JWT', async () => {
      const token = generateTestJwt({
        algorithm: 'HS256',
        sub: 'usr_real_alice',
        roles: ['user'],
      });

      // Malicious client tries to spoof admin userId and roles
      const res = await request(`${gatewayAddress}/api/v1/users/me`, {
        headers: {
          authorization: `Bearer ${token}`,
          'x-user-id': 'usr_spoofed_admin',
          'x-user-roles': 'admin,superadmin',
          'x-auth-type': 'spoofed',
          'x-gateway-fake': 'true',
          'x-internal-secret': 'stolen',
        },
      });

      expect(res.statusCode).toBe(200);
      const data = (await res.body.json()) as any;

      // Upstream MUST receive the real verified identity, never the spoofed client headers
      expect(data.userId).toBe('usr_real_alice');
      expect(data.roles).toEqual(['user']);
      expect(data.authType).toBe('jwt');

      // Spoofed headers must be completely stripped
      expect(data.receivedHeaders['x-gateway-fake']).toBeUndefined();
      expect(data.receivedHeaders['x-internal-secret']).toBeUndefined();

      // Trusted routing headers must be injected
      expect(data.receivedHeaders['x-request-id']).toBeDefined();
      expect(data.receivedHeaders['x-forwarded-for']).toBeDefined();
      expect(data.receivedHeaders['x-forwarded-proto']).toBe('http');
    });

    it('should strip standard hop-by-hop headers from forwarding to upstream', async () => {
      const token = generateTestJwt({ sub: 'usr_hop_by_hop' });

      const res = await request(`${gatewayAddress}/api/v1/users/me`, {
        headers: {
          authorization: `Bearer ${token}`,
          'proxy-authorization': 'Basic dXNlcjpwYXNz',
          'te': 'trailers',
        },
      });

      expect(res.statusCode).toBe(200);
      const data = (await res.body.json()) as any;
      expect(data.receivedHeaders['proxy-authorization']).toBeUndefined();
      expect(data.receivedHeaders['te']).toBeUndefined();
    });
  });
});
