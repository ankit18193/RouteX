import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { type FastifyInstance } from 'fastify';
import { request } from 'undici';
import { createGatewayServer, type RouteXGatewayServer } from '../../src/server/gateway-server.js';
import { buildUserService } from '../../mock-services/user-service/index.js';
import {
  generateTestJwt,
  TEST_JWT_SECRET,
  TEST_RSA_PUBLIC_KEY,
} from '../../mock-services/user-service/jwt-utils.js';
import type { GatewayConfigInput } from '../../src/types/index.js';

describe('RouteX Gateway Authentication & Identity Engine Integration', () => {
  let userService: FastifyInstance;
  let userAddress: string;

  let gateway: RouteXGatewayServer;
  let gatewayAddress: string;

  const validApiKey = 'rx_live_client_alpha_12345678901234567890';
  const revokedApiKey = 'rx_live_revoked_key_12345678901234567890';

  beforeAll(async () => {
    userService = buildUserService({ logger: false });
    userAddress = await userService.listen({ port: 0, host: '127.0.0.1' });

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
      auth: {
        jwt: {
          enabled: true,
          algorithms: ['HS256', 'RS256'],
          issuer: 'routex-mock-user-service',
          audience: 'routex-gateway',
          hs256Secret: TEST_JWT_SECRET,
          rs256PublicKey: TEST_RSA_PUBLIC_KEY,
        },
        apiKeys: {
          enabled: true,
          cacheTtlMs: 60000,
          cacheMaxEntries: 1000,
          keys: [
            {
              id: 'key_alpha_01',
              key: validApiKey,
              userId: 'usr_api_alpha',
              roles: ['api:read', 'api:write'],
              tier: 'business',
              revoked: false,
            },
            {
              id: 'key_revoked_02',
              key: revokedApiKey,
              userId: 'usr_api_revoked',
              roles: ['api:read'],
              revoked: true,
            },
          ],
        },
      },
      routes: [
        {
          id: 'public_route',
          pathPrefix: '/public/users/me',
          upstream: `${userAddress}/api/v1/users/me`,
          methods: ['GET'],
          stripPrefix: true,
          auth: { mode: 'public', requiredRoles: [] },
          timeouts: { connectTimeoutMs: 1000, responseTimeoutMs: 3000 },
        },
        {
          id: 'jwt_route',
          pathPrefix: '/jwt/users/me',
          upstream: `${userAddress}/api/v1/users/me`,
          methods: ['GET'],
          stripPrefix: true,
          auth: { mode: 'jwt', requiredRoles: [] },
          timeouts: { connectTimeoutMs: 1000, responseTimeoutMs: 3000 },
        },
        {
          id: 'apikey_route',
          pathPrefix: '/apikey/users/me',
          upstream: `${userAddress}/api/v1/users/me`,
          methods: ['GET'],
          stripPrefix: true,
          auth: { mode: 'api-key', requiredRoles: [] },
          timeouts: { connectTimeoutMs: 1000, responseTimeoutMs: 3000 },
        },
        {
          id: 'any_route',
          pathPrefix: '/any/users/me',
          upstream: `${userAddress}/api/v1/users/me`,
          methods: ['GET'],
          stripPrefix: true,
          auth: { mode: 'any', requiredRoles: [] },
          timeouts: { connectTimeoutMs: 1000, responseTimeoutMs: 3000 },
        },
        {
          id: 'admin_rbac_route',
          pathPrefix: '/rbac/admin/users/me',
          upstream: `${userAddress}/api/v1/users/me`,
          methods: ['GET'],
          stripPrefix: true,
          auth: { mode: 'jwt', requiredRoles: ['admin', 'system:manage'] },
          timeouts: { connectTimeoutMs: 1000, responseTimeoutMs: 3000 },
        },
      ],
    };

    gateway = createGatewayServer(gatewayConfig, { logger: false });
    gatewayAddress = await gateway.listen(0, '127.0.0.1');
  });

  afterAll(async () => {
    await gateway.close();
    await userService.close();
  });

  describe('Public Route Authentication Policy', () => {
    it('should allow anonymous access when no credentials provided', async () => {
      const res = await request(`${gatewayAddress}/public/users/me`);
      expect(res.statusCode).toBe(200);

      const body = (await res.body.json()) as Record<string, unknown>;
      expect(body.userId).toBeNull();
      expect(body.authType).toBe('anonymous');
      const received = body.receivedHeaders as Record<string, string>;
      expect(received['x-auth-type']).toBe('anonymous');
    });

    it('should authenticate and inject identity when valid JWT is supplied on public route', async () => {
      const token = generateTestJwt({ sub: 'usr_public_jwt_01', roles: ['user'] });
      const res = await request(`${gatewayAddress}/public/users/me`, {
        headers: {
          authorization: `Bearer ${token}`,
        },
      });

      expect(res.statusCode).toBe(200);
      const body = (await res.body.json()) as Record<string, unknown>;
      expect(body.userId).toBe('usr_public_jwt_01');
      expect(body.authType).toBe('jwt');
      expect(body.userRoles).toEqual(['user']);
    });

    it('should reject invalid credentials with 401 on public route', async () => {
      const res = await request(`${gatewayAddress}/public/users/me`, {
        headers: {
          authorization: 'Bearer invalid.tampered.token',
        },
      });

      expect(res.statusCode).toBe(401);
      expect(res.headers['www-authenticate']).toContain('Bearer realm="RouteX"');
    });
  });

  describe('JWT Route Authentication Policy', () => {
    it('should authenticate valid HS256 JWT and propagate trusted identity', async () => {
      const token = generateTestJwt({
        sub: 'usr_hs256_verified',
        roles: ['developer', 'chat:read'],
      });

      const res = await request(`${gatewayAddress}/jwt/users/me`, {
        headers: {
          authorization: `Bearer ${token}`,
        },
      });

      expect(res.statusCode).toBe(200);
      const body = (await res.body.json()) as Record<string, unknown>;
      expect(body.userId).toBe('usr_hs256_verified');
      expect(body.authType).toBe('jwt');
      expect(body.userRoles).toEqual(['developer', 'chat:read']);
    });

    it('should authenticate valid RS256 JWT', async () => {
      const token = generateTestJwt({
        algorithm: 'RS256',
        sub: 'usr_rs256_verified',
        roles: ['auditor'],
      });

      const res = await request(`${gatewayAddress}/jwt/users/me`, {
        headers: {
          authorization: `Bearer ${token}`,
        },
      });

      expect(res.statusCode).toBe(200);
      const body = (await res.body.json()) as Record<string, unknown>;
      expect(body.userId).toBe('usr_rs256_verified');
      expect(body.authType).toBe('jwt');
    });

    it('should return 401 Unauthorized when credentials are missing on JWT route', async () => {
      const res = await request(`${gatewayAddress}/jwt/users/me`);
      expect(res.statusCode).toBe(401);
      expect(res.headers['www-authenticate']).toContain('Bearer realm="RouteX"');
      const body = (await res.body.json()) as Record<string, unknown>;
      expect(body.error).toBe('UNAUTHORIZED');
    });

    it('should return 401 Unauthorized when JWT is expired', async () => {
      const token = generateTestJwt({ expiresInSec: -3600 });
      const res = await request(`${gatewayAddress}/jwt/users/me`, {
        headers: {
          authorization: `Bearer ${token}`,
        },
      });

      expect(res.statusCode).toBe(401);
      const body = (await res.body.json()) as Record<string, unknown>;
      expect(body.error).toBe('UNAUTHORIZED');
    });
  });

  describe('API-Key Route Authentication Policy', () => {
    it('should authenticate valid API key supplied via X-API-Key header', async () => {
      const res = await request(`${gatewayAddress}/apikey/users/me`, {
        headers: {
          'x-api-key': validApiKey,
        },
      });

      expect(res.statusCode).toBe(200);
      const body = (await res.body.json()) as Record<string, unknown>;
      expect(body.userId).toBe('usr_api_alpha');
      expect(body.authType).toBe('api-key');
      expect(body.userRoles).toEqual(['api:read', 'api:write']);
    });

    it('should authenticate valid API key supplied via Authorization: Bearer rx_live_...', async () => {
      const res = await request(`${gatewayAddress}/apikey/users/me`, {
        headers: {
          authorization: `Bearer ${validApiKey}`,
        },
      });

      expect(res.statusCode).toBe(200);
      const body = (await res.body.json()) as Record<string, unknown>;
      expect(body.userId).toBe('usr_api_alpha');
      expect(body.authType).toBe('api-key');
    });

    it('should return 401 Unauthorized for revoked API key', async () => {
      const res = await request(`${gatewayAddress}/apikey/users/me`, {
        headers: {
          'x-api-key': revokedApiKey,
        },
      });

      expect(res.statusCode).toBe(401);
      const body = (await res.body.json()) as Record<string, unknown>;
      expect(body.error).toBe('UNAUTHORIZED');
    });

    it('should return 401 Unauthorized when missing API key on API-key route', async () => {
      const res = await request(`${gatewayAddress}/apikey/users/me`);
      expect(res.statusCode).toBe(401);
    });
  });

  describe("'any' Auth Policy Route", () => {
    it('should accept valid JWT on any route', async () => {
      const token = generateTestJwt({ sub: 'usr_any_jwt' });
      const res = await request(`${gatewayAddress}/any/users/me`, {
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.statusCode).toBe(200);
      const body = (await res.body.json()) as Record<string, unknown>;
      expect(body.userId).toBe('usr_any_jwt');
      expect(body.authType).toBe('jwt');
    });

    it('should accept valid API key on any route', async () => {
      const res = await request(`${gatewayAddress}/any/users/me`, {
        headers: { 'x-api-key': validApiKey },
      });

      expect(res.statusCode).toBe(200);
      const body = (await res.body.json()) as Record<string, unknown>;
      expect(body.userId).toBe('usr_api_alpha');
      expect(body.authType).toBe('api-key');
    });

    it('should return 401 when no credentials provided on any route', async () => {
      const res = await request(`${gatewayAddress}/any/users/me`);
      expect(res.statusCode).toBe(401);
    });
  });

  describe('Role-Based Access Control (RBAC)', () => {
    it('should allow access when user possesses ALL required roles', async () => {
      const token = generateTestJwt({
        sub: 'usr_admin_all_roles',
        roles: ['admin', 'system:manage', 'user'],
      });

      const res = await request(`${gatewayAddress}/rbac/admin/users/me`, {
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.statusCode).toBe(200);
      const body = (await res.body.json()) as Record<string, unknown>;
      expect(body.userId).toBe('usr_admin_all_roles');
    });

    it('should return 403 Forbidden when user is missing one of the required roles', async () => {
      const token = generateTestJwt({
        sub: 'usr_partial_roles',
        roles: ['admin'], // Missing 'system:manage'
      });

      const res = await request(`${gatewayAddress}/rbac/admin/users/me`, {
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.statusCode).toBe(403);
      const body = (await res.body.json()) as Record<string, unknown>;
      expect(body.error).toBe('FORBIDDEN');
    });

    it('should return 403 Forbidden when user has no matching roles', async () => {
      const token = generateTestJwt({
        sub: 'usr_regular',
        roles: ['user'],
      });

      const res = await request(`${gatewayAddress}/rbac/admin/users/me`, {
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.statusCode).toBe(403);
      const body = (await res.body.json()) as Record<string, unknown>;
      expect(body.error).toBe('FORBIDDEN');
    });
  });

  describe('Identity Spoofing Defense', () => {
    it('should strip spoofed client headers and propagate only gateway-verified identity', async () => {
      const token = generateTestJwt({
        sub: 'usr_legitimate_client',
        roles: ['user'],
      });

      const res = await request(`${gatewayAddress}/jwt/users/me`, {
        headers: {
          authorization: `Bearer ${token}`,
          'x-user-id': 'spoofed_root_admin',
          'x-user-roles': 'superadmin,system:root',
          'x-auth-type': 'super-root',
          'x-gateway-custom': 'spoof-attack',
        },
      });

      expect(res.statusCode).toBe(200);
      const body = (await res.body.json()) as Record<string, unknown>;
      // Upstream must only see legitimate verified identity
      expect(body.userId).toBe('usr_legitimate_client');
      expect(body.userRoles).toEqual(['user']);
      expect(body.authType).toBe('jwt');

      const receivedHeaders = body.receivedHeaders as Record<string, string>;
      expect(receivedHeaders['x-gateway-custom']).toBeUndefined();
    });
  });
});
