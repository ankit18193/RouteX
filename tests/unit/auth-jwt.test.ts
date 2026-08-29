import { describe, it, expect } from 'vitest';
import { JwtVerifier, createJwtVerifier } from '../../src/auth/jwt-verifier.js';
import {
  generateTestJwt,
  TEST_JWT_SECRET,
  TEST_RSA_PUBLIC_KEY,
} from '../../mock-services/user-service/jwt-utils.js';
import { UnauthorizedError } from '../../src/errors/gateway-error.js';

describe('JwtVerifier', () => {
  const defaultVerifier = new JwtVerifier({
    hs256Secret: TEST_JWT_SECRET,
    rs256PublicKey: TEST_RSA_PUBLIC_KEY,
    issuer: 'routex-mock-user-service',
    audience: 'routex-gateway',
  });

  describe('HS256 Verification', () => {
    it('should verify valid HS256 JWT and return trusted AuthContext', () => {
      const token = generateTestJwt({
        sub: 'usr_hs256_01',
        roles: ['user', 'chat:write'],
        customClaims: { tier: 'premium' },
      });

      const auth = defaultVerifier.verify(token);
      expect(auth.authenticated).toBe(true);
      expect(auth.authType).toBe('jwt');
      expect(auth.userId).toBe('usr_hs256_01');
      expect(auth.roles).toEqual(['user', 'chat:write']);
      expect(auth.tier).toBe('premium');
      expect(auth.claims).toBeDefined();
    });

    it('should throw UnauthorizedError on expired HS256 JWT', () => {
      const expiredToken = generateTestJwt({
        expiresInSec: -100, // expired in past
      });

      expect(() => defaultVerifier.verify(expiredToken)).toThrow(UnauthorizedError);
      expect(() => defaultVerifier.verify(expiredToken)).toThrow('JWT has expired');
    });

    it('should throw UnauthorizedError on future nbf claim', () => {
      const futureToken = generateTestJwt({
        customClaims: {
          nbf: Math.floor(Date.now() / 1000) + 1000,
        },
      });

      expect(() => defaultVerifier.verify(futureToken)).toThrow(UnauthorizedError);
      expect(() => defaultVerifier.verify(futureToken)).toThrow('JWT is not active yet');
    });

    it('should throw UnauthorizedError on tampered HS256 signature', () => {
      const validToken = generateTestJwt();
      const parts = validToken.split('.');
      const tamperedToken = `${parts[0]}.${parts[1]}.tampered_signature`;

      expect(() => defaultVerifier.verify(tamperedToken)).toThrow(UnauthorizedError);
      expect(() => defaultVerifier.verify(tamperedToken)).toThrow('JWT signature verification failed');
    });

    it('should throw UnauthorizedError when verified with wrong HS256 secret', () => {
      const token = generateTestJwt();
      const wrongVerifier = new JwtVerifier({
        hs256Secret: 'wrong-secret-key-that-does-not-match-at-all!',
      });

      expect(() => wrongVerifier.verify(token)).toThrow(UnauthorizedError);
      expect(() => wrongVerifier.verify(token)).toThrow('JWT signature verification failed');
    });
  });

  describe('RS256 Verification', () => {
    it('should verify valid RS256 JWT and return trusted AuthContext', () => {
      const token = generateTestJwt({
        algorithm: 'RS256',
        sub: 'usr_rs256_02',
        roles: ['admin'],
        customClaims: { tier: 'enterprise' },
      });

      const auth = defaultVerifier.verify(token);
      expect(auth.authenticated).toBe(true);
      expect(auth.authType).toBe('jwt');
      expect(auth.userId).toBe('usr_rs256_02');
      expect(auth.roles).toEqual(['admin']);
      expect(auth.tier).toBe('enterprise');
    });

    it('should throw UnauthorizedError on tampered RS256 signature', () => {
      const token = generateTestJwt({ algorithm: 'RS256' });
      const parts = token.split('.');
      const tampered = `${parts[0]}.${parts[1]}.fakeRS256Signature`;

      expect(() => defaultVerifier.verify(tampered)).toThrow(UnauthorizedError);
      expect(() => defaultVerifier.verify(tampered)).toThrow('JWT signature verification failed');
    });
  });

  describe('Security & Algorithm Constraints', () => {
    it('should reject alg: none tokens unconditionally', () => {
      const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
      const payload = Buffer.from(JSON.stringify({ sub: 'usr_none', iss: 'routex-mock-user-service', aud: 'routex-gateway' })).toString('base64url');
      const noneToken = `${header}.${payload}.`;

      expect(() => defaultVerifier.verify(noneToken)).toThrow(UnauthorizedError);
      expect(() => defaultVerifier.verify(noneToken)).toThrow('Unsupported or disallowed JWT algorithm');
    });

    it('should reject unsupported or disallowed algorithms (e.g. ES256 when only HS256/RS256 configured)', () => {
      const header = Buffer.from(JSON.stringify({ alg: 'ES256', typ: 'JWT' })).toString('base64url');
      const payload = Buffer.from(JSON.stringify({ sub: 'usr_es', iss: 'routex-mock-user-service', aud: 'routex-gateway' })).toString('base64url');
      const token = `${header}.${payload}.sig`;

      expect(() => defaultVerifier.verify(token)).toThrow(UnauthorizedError);
    });

    it('should reject issuer mismatch', () => {
      const token = generateTestJwt({
        customClaims: {
          iss: 'untrusted-rogue-issuer',
        },
      });

      expect(() => defaultVerifier.verify(token)).toThrow(UnauthorizedError);
      expect(() => defaultVerifier.verify(token)).toThrow('JWT issuer mismatch');
    });

    it('should reject audience mismatch', () => {
      const token = generateTestJwt({
        customClaims: {
          aud: 'different-audience',
        },
      });

      expect(() => defaultVerifier.verify(token)).toThrow(UnauthorizedError);
      expect(() => defaultVerifier.verify(token)).toThrow('JWT audience mismatch');
    });

    it("should reject token missing 'sub' claim", () => {
      const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
      const payload = Buffer.from(
        JSON.stringify({
          iss: 'routex-mock-user-service',
          aud: 'routex-gateway',
          exp: Math.floor(Date.now() / 1000) + 3600,
        })
      ).toString('base64url');
      const data = `${header}.${payload}`;
      const sig = generateTestJwt({ customClaims: { iss: 'routex-mock-user-service', aud: 'routex-gateway' } }).split('.')[2];
      const token = `${data}.${sig}`;

      expect(() => defaultVerifier.verify(token)).toThrow(UnauthorizedError);
    });

    it('should reject malformed token segment structure', () => {
      expect(() => defaultVerifier.verify('not.a.valid.jwt.token')).toThrow(UnauthorizedError);
      expect(() => defaultVerifier.verify('single_part')).toThrow(UnauthorizedError);
      expect(() => defaultVerifier.verify('')).toThrow(UnauthorizedError);
    });
  });

  describe('createJwtVerifier Factory with Environment Variables', () => {
    it('should load secrets from environment variable names', () => {
      process.env.TEST_CUSTOM_JWT_SECRET = 'env-loaded-secret-12345678901234567890!';
      const verifier = createJwtVerifier({
        hs256SecretEnv: 'TEST_CUSTOM_JWT_SECRET',
      });

      expect(verifier).toBeInstanceOf(JwtVerifier);
      delete process.env.TEST_CUSTOM_JWT_SECRET;
    });
  });
});
