import { describe, it, expect } from 'vitest';
import {
  isRequestCacheable,
  isResponseCacheable,
  sanitizeCacheHeaders,
} from '../../src/cache/cache-policy.js';
import type { RouteDefinition, RouteCachePolicy } from '../../src/types/index.js';
import type { AuthContext } from '../../src/auth/types.js';

describe('Cache Policy Evaluation', () => {
  const baseRoute: RouteDefinition = {
    id: 'route_items',
    pathPrefix: '/items',
    upstream: 'http://localhost:4001',
    stripPrefix: false,
    methods: ['GET', 'POST'],
    auth: { mode: 'public', requiredRoles: [] },
    timeouts: { connectTimeoutMs: 1000, responseTimeoutMs: 3000 },
    cache: {
      enabled: true,
      ttlSec: 60,
      respectCacheControl: true,
      maxBodyBytes: 1024 * 1024,
      varyBy: [],
      allowAuthenticated: false,
    },
  };

  describe('isRequestCacheable', () => {
    it('should return false if cache is not enabled on route', () => {
      const routeNoCache = { ...baseRoute, cache: undefined };
      const res = isRequestCacheable(routeNoCache, 'GET', {});
      expect(res.cacheable).toBe(false);
      expect(res.reason).toBe('CACHE_DISABLED');
    });

    it('should return false for non-GET methods (e.g. POST, PUT, DELETE)', () => {
      expect(isRequestCacheable(baseRoute, 'POST', {}).cacheable).toBe(false);
      expect(isRequestCacheable(baseRoute, 'PUT', {}).cacheable).toBe(false);
      expect(isRequestCacheable(baseRoute, 'DELETE', {}).cacheable).toBe(false);
    });

    it('should return true for safe GET request on public route', () => {
      const res = isRequestCacheable(baseRoute, 'GET', {});
      expect(res.cacheable).toBe(true);
    });

    it('should reject authenticated requests when allowAuthenticated is false', () => {
      const authCtx: AuthContext = {
        authenticated: true,
        authType: 'jwt',
        userId: 'usr_1',
        roles: ['user'],
      };
      const res = isRequestCacheable(baseRoute, 'GET', {}, authCtx);
      expect(res.cacheable).toBe(false);
      expect(res.reason).toBe('AUTHENTICATED_REQUEST_NOT_PERMITTED');
    });

    it('should allow authenticated requests when allowAuthenticated is true', () => {
      const routeAuthCache: RouteDefinition = {
        ...baseRoute,
        cache: {
          ...baseRoute.cache!,
          allowAuthenticated: true,
        },
      };
      const authCtx: AuthContext = {
        authenticated: true,
        authType: 'jwt',
        userId: 'usr_1',
        roles: ['user'],
      };
      const res = isRequestCacheable(routeAuthCache, 'GET', {}, authCtx);
      expect(res.cacheable).toBe(true);
    });

    it('should bypass cache when client specifies Cache-Control: no-store', () => {
      const res = isRequestCacheable(baseRoute, 'GET', { 'cache-control': 'no-store' });
      expect(res.cacheable).toBe(false);
      expect(res.reason).toBe('CLIENT_NO_STORE');
    });
  });

  describe('isResponseCacheable', () => {
    const policy: RouteCachePolicy = {
      enabled: true,
      ttlSec: 60,
      respectCacheControl: true,
      maxBodyBytes: 1024,
      varyBy: [],
      allowAuthenticated: false,
    };

    it('should allow caching 200 OK responses within maxBodyBytes', () => {
      const res = isResponseCacheable(200, { 'content-type': 'application/json' }, 500, policy);
      expect(res.cacheable).toBe(true);
      expect(res.ttlSec).toBe(60);
    });

    it('should reject non-200 responses (e.g. 404, 500, 401)', () => {
      expect(isResponseCacheable(404, {}, 100, policy).cacheable).toBe(false);
      expect(isResponseCacheable(500, {}, 100, policy).cacheable).toBe(false);
      expect(isResponseCacheable(401, {}, 100, policy).cacheable).toBe(false);
    });

    it('should reject responses exceeding maxBodyBytes', () => {
      const res = isResponseCacheable(200, {}, 2048, policy);
      expect(res.cacheable).toBe(false);
      expect(res.reason).toBe('RESPONSE_BODY_EXCEEDS_MAX_BYTES');
    });

    it('should reject responses with Cache-Control: no-store', () => {
      const res = isResponseCacheable(200, { 'cache-control': 'no-store, no-cache' }, 100, policy);
      expect(res.cacheable).toBe(false);
      expect(res.reason).toBe('UPSTREAM_NO_STORE');
    });

    it('should reject responses with Cache-Control: private when allowAuthenticated is false', () => {
      const res = isResponseCacheable(200, { 'cache-control': 'private, max-age=300' }, 100, policy);
      expect(res.cacheable).toBe(false);
      expect(res.reason).toBe('UPSTREAM_PRIVATE');
    });

    it('should parse and apply upstream Cache-Control max-age', () => {
      const res = isResponseCacheable(200, { 'cache-control': 'public, max-age=120' }, 100, policy);
      expect(res.cacheable).toBe(true);
      expect(res.ttlSec).toBe(120);
    });

    it('should reject upstream Cache-Control max-age=0', () => {
      const res = isResponseCacheable(200, { 'cache-control': 'max-age=0' }, 100, policy);
      expect(res.cacheable).toBe(false);
      expect(res.reason).toBe('UPSTREAM_MAX_AGE_ZERO');
    });
  });

  describe('sanitizeCacheHeaders', () => {
    it('should strip hop-by-hop and sensitive headers', () => {
      const raw = {
        'Content-Type': 'application/json',
        'Set-Cookie': 'session=abc',
        Authorization: 'Bearer secret',
        Connection: 'keep-alive',
        'X-Custom-Header': 'val',
      };
      const sanitized = sanitizeCacheHeaders(raw);
      expect(sanitized['content-type']).toBe('application/json');
      expect(sanitized['x-custom-header']).toBe('val');
      expect(sanitized['set-cookie']).toBeUndefined();
      expect(sanitized['authorization']).toBeUndefined();
      expect(sanitized['connection']).toBeUndefined();
    });
  });
});
