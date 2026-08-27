import { describe, it, expect } from 'vitest';
import {
  ServerConfigSchema,
  RedisConfigSchema,
  RouteDefinitionSchema,
  RoutesListSchema,
  GatewayConfigSchema,
} from '../../src/config/schema.js';

describe('Configuration Schemas (Zod)', () => {
  describe('ServerConfigSchema', () => {
    it('should parse valid server config with defaults', () => {
      const parsed = ServerConfigSchema.parse({});
      expect(parsed.port).toBe(8080);
      expect(parsed.host).toBe('0.0.0.0');
      expect(parsed.requestTimeoutMs).toBe(10000);
      expect(parsed.headersTimeoutMs).toBe(11000);
      expect(parsed.maxHeaderSize).toBe(16384);
      expect(parsed.logLevel).toBe('info');
      expect(parsed.logFormat).toBe('json');
      expect(parsed.trustedProxies).toEqual(['127.0.0.1', '::1']);
    });

    it('should reject invalid port numbers', () => {
      expect(() => ServerConfigSchema.parse({ port: 0 })).toThrow();
      expect(() => ServerConfigSchema.parse({ port: 70000 })).toThrow();
      expect(() => ServerConfigSchema.parse({ port: -1 })).toThrow();
    });

    it('should reject headersTimeoutMs <= requestTimeoutMs', () => {
      expect(() =>
        ServerConfigSchema.parse({
          requestTimeoutMs: 10000,
          headersTimeoutMs: 10000,
        })
      ).toThrow(/headersTimeoutMs must be strictly greater than requestTimeoutMs/);

      expect(() =>
        ServerConfigSchema.parse({
          requestTimeoutMs: 15000,
          headersTimeoutMs: 10000,
        })
      ).toThrow(/headersTimeoutMs must be strictly greater than requestTimeoutMs/);
    });

    it('should accept valid custom values', () => {
      const parsed = ServerConfigSchema.parse({
        port: 3000,
        host: '127.0.0.1',
        requestTimeoutMs: 5000,
        headersTimeoutMs: 6000,
        logLevel: 'debug',
        logFormat: 'pretty',
      });
      expect(parsed.port).toBe(3000);
      expect(parsed.logLevel).toBe('debug');
      expect(parsed.logFormat).toBe('pretty');
    });
  });

  describe('RedisConfigSchema', () => {
    it('should parse valid redis config with defaults', () => {
      const parsed = RedisConfigSchema.parse({});
      expect(parsed.host).toBe('localhost');
      expect(parsed.port).toBe(6379);
      expect(parsed.db).toBe(0);
      expect(parsed.tls).toBe(false);
      expect(parsed.connectTimeoutMs).toBe(3000);
    });

    it('should accept custom redis config with password and tls', () => {
      const parsed = RedisConfigSchema.parse({
        host: 'redis.internal',
        port: 6380,
        password: 'super-secret-pw',
        db: 2,
        tls: true,
        connectTimeoutMs: 5000,
      });
      expect(parsed.host).toBe('redis.internal');
      expect(parsed.port).toBe(6380);
      expect(parsed.password).toBe('super-secret-pw');
      expect(parsed.tls).toBe(true);
    });
  });

  describe('RouteDefinitionSchema', () => {
    it('should parse a minimal valid route', () => {
      const parsed = RouteDefinitionSchema.parse({
        id: 'user_service',
        pathPrefix: '/api/v1/users',
        upstream: 'http://localhost:4001',
      });

      expect(parsed.id).toBe('user_service');
      expect(parsed.pathPrefix).toBe('/api/v1/users');
      expect(parsed.upstream).toBe('http://localhost:4001');
      expect(parsed.stripPrefix).toBe(false);
      expect(parsed.methods).toContain('GET');
      expect(parsed.methods).toContain('POST');
      expect(parsed.auth.mode).toBe('public');
      expect(parsed.timeouts.connectTimeoutMs).toBe(1000);
      expect(parsed.timeouts.responseTimeoutMs).toBe(3000);
    });

    it('should reject route id with invalid characters', () => {
      expect(() =>
        RouteDefinitionSchema.parse({
          id: 'user service invalid!',
          pathPrefix: '/api/users',
          upstream: 'http://localhost:4001',
        })
      ).toThrow(/Route id must contain only alphanumeric/);
    });

    it('should reject pathPrefix without leading slash', () => {
      expect(() =>
        RouteDefinitionSchema.parse({
          id: 'users',
          pathPrefix: 'api/users',
          upstream: 'http://localhost:4001',
        })
      ).toThrow(/pathPrefix must start with a leading slash/);
    });

    it('should reject pathPrefix with trailing slash when length > 1', () => {
      expect(() =>
        RouteDefinitionSchema.parse({
          id: 'users',
          pathPrefix: '/api/users/',
          upstream: 'http://localhost:4001',
        })
      ).toThrow(/pathPrefix must not have a trailing slash/);
    });

    it('should allow pathPrefix of exactly "/"', () => {
      const parsed = RouteDefinitionSchema.parse({
        id: 'root',
        pathPrefix: '/',
        upstream: 'http://localhost:4001',
      });
      expect(parsed.pathPrefix).toBe('/');
    });

    it('should reject upstream without valid http or https protocol', () => {
      expect(() =>
        RouteDefinitionSchema.parse({
          id: 'users',
          pathPrefix: '/users',
          upstream: 'ftp://localhost:4001',
        })
      ).toThrow(/upstream protocol must be http:\/\/ or https:\/\//);

      expect(() =>
        RouteDefinitionSchema.parse({
          id: 'users',
          pathPrefix: '/users',
          upstream: 'invalid-url',
        })
      ).toThrow(/upstream must be a valid URL/);
    });

    it('should parse authenticated route with rate limiting policies', () => {
      const parsed = RouteDefinitionSchema.parse({
        id: 'chat_api',
        pathPrefix: '/chats',
        upstream: 'https://chat-service.internal',
        methods: ['GET', 'POST'],
        auth: {
          mode: 'jwt',
          requiredRoles: ['chat:read', 'chat:write'],
        },
        rateLimit: {
          enabled: true,
          windowSec: 60,
          limit: 150,
          failurePolicy: 'fail-closed',
          tiers: {
            basic: 50,
            pro: 500,
          },
        },
        timeouts: {
          connectTimeoutMs: 2000,
          responseTimeoutMs: 8000,
        },
      });

      expect(parsed.auth.mode).toBe('jwt');
      expect(parsed.auth.requiredRoles).toEqual(['chat:read', 'chat:write']);
      expect(parsed.rateLimit?.failurePolicy).toBe('fail-closed');
      expect(parsed.rateLimit?.tiers?.pro).toBe(500);
      expect(parsed.timeouts.responseTimeoutMs).toBe(8000);
    });

    it('should reject invalid rateLimit failurePolicy', () => {
      expect(() =>
        RouteDefinitionSchema.parse({
          id: 'chat_api',
          pathPrefix: '/chats',
          upstream: 'http://localhost:4002',
          rateLimit: {
            enabled: true,
            windowSec: 60,
            limit: 100,
            failurePolicy: 'invalid-policy' as any,
          },
        })
      ).toThrow();
    });
  });

  describe('RoutesListSchema: Duplicates & Collisions', () => {
    it('should reject duplicate route IDs', () => {
      const duplicateRoutes = [
        {
          id: 'duplicate_id',
          pathPrefix: '/users',
          upstream: 'http://localhost:4001',
          methods: ['GET'],
        },
        {
          id: 'duplicate_id',
          pathPrefix: '/chats',
          upstream: 'http://localhost:4002',
          methods: ['POST'],
        },
      ];

      expect(() => RoutesListSchema.parse(duplicateRoutes)).toThrow(
        /All route IDs must be globally unique/
      );
    });

    it('should reject route collisions with identical pathPrefix and HTTP method', () => {
      const collidingRoutes = [
        {
          id: 'user_service_read',
          pathPrefix: '/api/v1/users',
          upstream: 'http://localhost:4001',
          methods: ['GET', 'POST'],
        },
        {
          id: 'user_service_backup',
          pathPrefix: '/api/v1/users',
          upstream: 'http://localhost:4003',
          methods: ['GET', 'DELETE'], // GET collides with user_service_read!
        },
      ];

      expect(() => RoutesListSchema.parse(collidingRoutes)).toThrow(
        /Route collision detected: multiple routes cannot define the same HTTP method and exact pathPrefix/
      );
    });

    it('should accept routes with the same pathPrefix if HTTP methods are strictly disjoint', () => {
      const disjointRoutes = [
        {
          id: 'user_service_get',
          pathPrefix: '/api/v1/users',
          upstream: 'http://localhost:4001',
          methods: ['GET'],
        },
        {
          id: 'user_service_post',
          pathPrefix: '/api/v1/users',
          upstream: 'http://localhost:4001',
          methods: ['POST', 'PUT'],
        },
      ];

      const parsed = RoutesListSchema.parse(disjointRoutes);
      expect(parsed).toHaveLength(2);
    });

    it('should accept distinct routes', () => {
      const routes = [
        {
          id: 'route_1',
          pathPrefix: '/users',
          upstream: 'http://localhost:4001',
        },
        {
          id: 'route_2',
          pathPrefix: '/chats',
          upstream: 'http://localhost:4002',
        },
      ];

      const parsed = RoutesListSchema.parse(routes);
      expect(parsed).toHaveLength(2);
    });
  });

  describe('GatewayConfigSchema', () => {
    it('should parse complete gateway configuration and inherit server defaults', () => {
      const config = GatewayConfigSchema.parse({
        routes: [
          {
            id: 'users',
            pathPrefix: '/users',
            upstream: 'http://localhost:4001',
          },
        ],
      });

      expect(config.server.port).toBe(8080);
      expect(config.server.host).toBe('0.0.0.0');
      expect(config.redis.host).toBe('localhost');
      expect(config.redis.port).toBe(6379);
      expect(config.routes).toHaveLength(1);
    });
  });
});
