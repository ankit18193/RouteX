import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { type FastifyInstance } from 'fastify';
import {
  buildUserService,
  generateTestJwt,
  verifyTestJwt,
  TEST_JWT_SECRET,
  TEST_RSA_PUBLIC_KEY,
} from '../../mock-services/user-service/index.js';

describe('Mock User Service', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = buildUserService({ logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('GET /healthz', () => {
    it('should return 200 with health status', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/healthz',
      });

      expect(response.statusCode).toBe(200);
      const json = response.json();
      expect(json.status).toBe('ok');
      expect(json.service).toBe('user-service');
      expect(typeof json.timestamp).toBe('string');
    });
  });

  describe('GET /api/v1/users/me (Identity Reflection)', () => {
    it('should reflect incoming downstream headers when present', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/users/me',
        headers: {
          'x-user-id': 'usr_alice_456',
          'x-user-roles': 'admin,billing,editor',
          'x-request-id': 'req_test_abc123',
          'x-auth-type': 'jwt',
        },
      });

      expect(response.statusCode).toBe(200);
      const json = response.json();
      expect(json.userId).toBe('usr_alice_456');
      expect(json.roles).toEqual(['admin', 'billing', 'editor']);
      expect(json.requestId).toBe('req_test_abc123');
      expect(json.authType).toBe('jwt');
      expect(json.service).toBe('user-service');
    });

    it('should handle missing downstream headers gracefully', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/users/me',
      });

      expect(response.statusCode).toBe(200);
      const json = response.json();
      expect(json.userId).toBeNull();
      expect(json.roles).toEqual([]);
      expect(json.requestId).toBeNull();
      expect(json.authType).toBeNull();
    });
  });

  describe('POST /api/v1/auth/token', () => {
    it('should generate a valid HS256 JWT by default', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/token',
        payload: {
          sub: 'usr_custom_99',
          roles: ['admin', 'service'],
          expiresInSec: 7200,
        },
      });

      expect(response.statusCode).toBe(200);
      const json = response.json();
      expect(json.tokenType).toBe('Bearer');
      expect(json.expiresIn).toBe(7200);
      expect(json.algorithm).toBe('HS256');
      expect(typeof json.token).toBe('string');

      const verified = verifyTestJwt(json.token, 'HS256');
      expect(verified.header.alg).toBe('HS256');
      expect(verified.payload.sub).toBe('usr_custom_99');
      expect(verified.payload.roles).toEqual(['admin', 'service']);
    });

    it('should generate a valid RS256 JWT when requested', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/token',
        payload: {
          sub: 'usr_rsa_user',
          roles: ['analytics'],
          algorithm: 'RS256',
          claims: { tenantId: 'tenant_omega' },
        },
      });

      expect(response.statusCode).toBe(200);
      const json = response.json();
      expect(json.algorithm).toBe('RS256');

      const verified = verifyTestJwt(json.token, 'RS256');
      expect(verified.header.alg).toBe('RS256');
      expect(verified.payload.sub).toBe('usr_rsa_user');
      expect(verified.payload.tenantId).toBe('tenant_omega');
    });

    it('should reject unsupported algorithms with 400', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/token',
        payload: {
          algorithm: 'ES256',
        },
      });

      expect(response.statusCode).toBe(400);
      const json = response.json();
      expect(json.error).toBe('BAD_REQUEST');
      expect(json.message).toContain('Algorithm must be "HS256" or "RS256"');
    });

    it('should reject invalid expiresInSec with 400', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/token',
        payload: {
          expiresInSec: -50,
        },
      });

      expect(response.statusCode).toBe(400);
      const json = response.json();
      expect(json.error).toBe('BAD_REQUEST');
    });
  });

  describe('GET /api/v1/users/slow', () => {
    it('should delay response by requested delayMs', async () => {
      const start = Date.now();
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/users/slow?delayMs=35',
      });
      const elapsed = Date.now() - start;

      expect(response.statusCode).toBe(200);
      const json = response.json();
      expect(json.status).toBe('ok');
      expect(json.delayedMs).toBe(35);
      expect(elapsed).toBeGreaterThanOrEqual(30);
    });

    it('should reject negative or zero delayMs with 400', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/users/slow?delayMs=-10',
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error).toBe('BAD_REQUEST');
    });

    it('should reject delayMs greater than 60000 with 400', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/users/slow?delayMs=70000',
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error).toBe('BAD_REQUEST');
    });

    it('should reject non-numeric delayMs with 400', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/users/slow?delayMs=notanumber',
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error).toBe('BAD_REQUEST');
    });
  });

  describe('GET /api/v1/users/fault', () => {
    it('should return controlled 500 error when type=500', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/users/fault?type=500',
      });

      expect(response.statusCode).toBe(500);
      const json = response.json();
      expect(json.error).toBe('INTERNAL_SERVER_ERROR');
      expect(json.message).toContain('Simulated upstream 500 error');
    });

    it('should reject invalid fault type with 400', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/users/fault?type=invalid_type',
      });

      expect(response.statusCode).toBe(400);
      const json = response.json();
      expect(json.error).toBe('BAD_REQUEST');
      expect(json.message).toContain('must be "500" or "crash"');
    });
  });

  describe('JWT Utilities', () => {
    it('should reject expired JWTs during verification', () => {
      const expiredToken = generateTestJwt({
        expiresInSec: -100, // already expired
      });

      expect(() => verifyTestJwt(expiredToken, 'HS256')).toThrow(/expired/);
    });

    it('should reject tampered signature', () => {
      const validToken = generateTestJwt({ sub: 'usr_valid' });
      const parts = validToken.split('.');
      const tampered = `${parts[0]}.${parts[1]}.invalid_signature_string`;

      expect(() => verifyTestJwt(tampered, 'HS256')).toThrow(/verification failed/);
    });

    it('should reject malformed tokens', () => {
      expect(() => verifyTestJwt('not.a.valid.jwt.with.too.many.dots')).toThrow(/must contain 3 segments/);
      expect(() => verifyTestJwt('single_string')).toThrow(/must contain 3 segments/);
    });

    it('should expose valid test secrets and public keys', () => {
      expect(TEST_JWT_SECRET.length).toBeGreaterThanOrEqual(32);
      expect(TEST_RSA_PUBLIC_KEY).toContain('BEGIN PUBLIC KEY');
    });
  });
});
