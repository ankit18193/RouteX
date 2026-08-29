import { describe, it, expect } from 'vitest';
import { ProxyRouter } from '../../src/proxy/router.js';
import type { RouteDefinition } from '../../src/types/index.js';

describe('ProxyRouter', () => {
  const routes: RouteDefinition[] = [
    {
      id: 'users_root',
      pathPrefix: '/api/v1/users',
      upstream: 'http://localhost:4001',
      methods: ['GET', 'POST'],
      stripPrefix: false,
      auth: { mode: 'public', requiredRoles: [] },
      timeouts: { connectTimeoutMs: 1000, responseTimeoutMs: 3000 },
    },
    {
      id: 'users_admin',
      pathPrefix: '/api/v1/users/admin',
      upstream: 'http://localhost:4001/admin',
      methods: ['GET'],
      stripPrefix: true,
      auth: { mode: 'jwt', requiredRoles: ['admin'] },
      timeouts: { connectTimeoutMs: 1000, responseTimeoutMs: 5000 },
    },
    {
      id: 'chats_service',
      pathPrefix: '/api/v1/chats',
      upstream: 'http://localhost:4002/v1',
      methods: ['GET', 'POST', 'PUT'],
      stripPrefix: true,
      auth: { mode: 'public', requiredRoles: [] },
      timeouts: { connectTimeoutMs: 1000, responseTimeoutMs: 3000 },
    },
    {
      id: 'catch_all',
      pathPrefix: '/',
      upstream: 'http://localhost:4000',
      methods: ['GET'],
      stripPrefix: false,
      auth: { mode: 'public', requiredRoles: [] },
      timeouts: { connectTimeoutMs: 1000, responseTimeoutMs: 3000 },
    },
  ];

  const router = new ProxyRouter(routes);

  describe('Longest Prefix Matching', () => {
    it('should match longer prefix /api/v1/users/admin before /api/v1/users', () => {
      const match = router.match('/api/v1/users/admin/settings', 'GET');
      expect(match.matched).toBe(true);
      if (match.matched) {
        expect(match.route.id).toBe('users_admin');
        expect(match.remainingPath).toBe('/settings');
        expect(match.targetUrl).toBe('http://localhost:4001/admin/settings');
      }
    });

    it('should match /api/v1/users for general user path', () => {
      const match = router.match('/api/v1/users/me', 'GET');
      expect(match.matched).toBe(true);
      if (match.matched) {
        expect(match.route.id).toBe('users_root');
        expect(match.remainingPath).toBe('/api/v1/users/me');
        expect(match.targetUrl).toBe('http://localhost:4001/api/v1/users/me');
      }
    });

    it('should strip prefix when stripPrefix is true', () => {
      const match = router.match('/api/v1/chats/chat_1/messages', 'POST');
      expect(match.matched).toBe(true);
      if (match.matched) {
        expect(match.route.id).toBe('chats_service');
        expect(match.remainingPath).toBe('/chat_1/messages');
        expect(match.targetUrl).toBe('http://localhost:4002/v1/chat_1/messages');
      }
    });

    it('should preserve query parameters in targetUrl', () => {
      const match = router.match('/api/v1/users/me', 'GET', '?include=profile&limit=5');
      expect(match.matched).toBe(true);
      if (match.matched) {
        expect(match.targetUrl).toBe('http://localhost:4001/api/v1/users/me?include=profile&limit=5');
      }
    });
  });

  describe('Boundary and Method Checks', () => {
    it('should not match /api/v1/users-fake to /api/v1/users (segment boundary)', () => {
      const match = router.match('/api/v1/users-fake', 'GET');
      expect(match.matched).toBe(true);
      if (match.matched) {
        // Falls back to root catch-all '/'
        expect(match.route.id).toBe('catch_all');
      }
    });

    it('should return METHOD_NOT_ALLOWED when path matches but method differs', () => {
      const match = router.match('/api/v1/users/admin/dashboard', 'POST');
      // users_admin only allows GET
      expect(match.matched).toBe(false);
      if (!match.matched) {
        expect(match.reason).toBe('METHOD_NOT_ALLOWED');
        expect(match.allowedMethods).toContain('GET');
      }
    });

    it('should return NOT_FOUND when no route matches and no catch-all exists', () => {
      const isolatedRouter = new ProxyRouter([
        {
          id: 'isolated_route',
          pathPrefix: '/isolated',
          upstream: 'http://localhost:9000',
          methods: ['GET'],
          stripPrefix: false,
          auth: { mode: 'public', requiredRoles: [] },
          timeouts: { connectTimeoutMs: 1000, responseTimeoutMs: 3000 },
        },
      ]);

      const match = isolatedRouter.match('/unknown-path', 'GET');
      expect(match.matched).toBe(false);
      if (!match.matched) {
        expect(match.reason).toBe('NOT_FOUND');
      }
    });
  });
});
