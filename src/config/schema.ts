import { z } from 'zod';

export const HttpMethodSchema = z.enum([
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'HEAD',
  'OPTIONS',
]);

export const AuthModeSchema = z.enum(['public', 'jwt', 'api-key', 'any']);

export const RateLimitFailurePolicySchema = z.enum(['fail-open', 'fail-closed']);

export const LogLevelSchema = z.enum([
  'fatal',
  'error',
  'warn',
  'info',
  'debug',
  'trace',
  'silent',
]);

export const LogFormatSchema = z.enum(['json', 'pretty']);

export const ServerConfigSchema = z
  .object({
    port: z.number().int().min(1).max(65535).default(8080),
    host: z.string().min(1).default('0.0.0.0'),
    requestTimeoutMs: z.number().int().min(100).max(300000).default(10000),
    headersTimeoutMs: z.number().int().min(100).max(300000).default(11000),
    maxHeaderSize: z.number().int().min(1024).max(65536).default(16384),
    trustedProxies: z.array(z.string().min(1)).default(['127.0.0.1', '::1']),
    logLevel: LogLevelSchema.default('info'),
    logFormat: LogFormatSchema.default('json'),
  })
  .refine((cfg) => cfg.headersTimeoutMs > cfg.requestTimeoutMs, {
    message: 'headersTimeoutMs must be strictly greater than requestTimeoutMs to prevent Node.js socket race conditions',
    path: ['headersTimeoutMs'],
  });

export const RedisConfigSchema = z.object({
  host: z.string().min(1).default('localhost'),
  port: z.number().int().min(1).max(65535).default(6379),
  password: z.string().optional(),
  db: z.number().int().min(0).max(15).optional().default(0),
  tls: z.boolean().optional().default(false),
  connectTimeoutMs: z.number().int().min(100).max(30000).default(3000),
});

export const JwtAlgorithmSchema = z.enum(['HS256', 'RS256']);

export const JwtConfigSchema = z.object({
  enabled: z.boolean().default(true),
  algorithms: z.array(JwtAlgorithmSchema).default(['HS256', 'RS256']),
  issuer: z.string().min(1).optional(),
  audience: z.string().min(1).optional(),
  hs256Secret: z.string().min(1).optional(),
  rs256PublicKey: z.string().min(1).optional(),
  hs256SecretEnv: z.string().min(1).optional(),
  rs256PublicKeyEnv: z.string().min(1).optional(),
});

export const ApiKeyDefinitionSchema = z.object({
  id: z.string().min(1),
  key: z.string().min(1),
  userId: z.string().min(1),
  roles: z.array(z.string().min(1)).default([]),
  tier: z.string().min(1).optional(),
  revoked: z.boolean().default(false),
  expiresAt: z.union([z.string(), z.number()]).optional(),
});

export const ApiKeysConfigSchema = z.object({
  enabled: z.boolean().default(true),
  cacheTtlMs: z.number().int().min(1).max(3600000).default(60000),
  cacheMaxEntries: z.number().int().min(1).max(1000000).default(1000),
  keys: z.array(ApiKeyDefinitionSchema).default([]),
});

export const AuthConfigSchema = z.object({
  jwt: JwtConfigSchema.optional(),
  apiKeys: ApiKeysConfigSchema.optional(),
});

export const RouteAuthPolicySchema = z.object({
  mode: AuthModeSchema.default('public'),
  requiredRoles: z.array(z.string().min(1)).optional().default([]),
});

export const RouteRateLimitPolicySchema = z.object({
  enabled: z.boolean().default(true),
  windowSec: z.number().int().min(1).max(86400).default(60),
  limit: z.number().int().min(1).default(100),
  failurePolicy: RateLimitFailurePolicySchema.default('fail-closed'),
  tiers: z.record(z.string(), z.number().int().min(1)).optional(),
});

export const RouteTimeoutPolicySchema = z.object({
  connectTimeoutMs: z.number().int().min(50).max(30000).default(1000),
  responseTimeoutMs: z.number().int().min(50).max(120000).default(3000),
});

export const RouteDefinitionSchema = z.object({
  id: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[a-zA-Z0-9_-]+$/, 'Route id must contain only alphanumeric characters, dashes, and underscores'),
  pathPrefix: z
    .string()
    .min(1)
    .startsWith('/', 'pathPrefix must start with a leading slash')
    .refine(
      (val) => val === '/' || !val.endsWith('/'),
      'pathPrefix must not have a trailing slash unless it is exactly "/"'
    ),
  upstream: z
    .string()
    .url('upstream must be a valid URL')
    .refine(
      (val) => val.startsWith('http://') || val.startsWith('https://'),
      'upstream protocol must be http:// or https://'
    ),
  stripPrefix: z.boolean().default(false),
  methods: z.array(HttpMethodSchema).min(1, 'methods array must not be empty').default([
    'GET',
    'POST',
    'PUT',
    'PATCH',
    'DELETE',
    'HEAD',
    'OPTIONS',
  ]),
  auth: RouteAuthPolicySchema.default({ mode: 'public' }),
  rateLimit: RouteRateLimitPolicySchema.optional(),
  timeouts: RouteTimeoutPolicySchema.default({
    connectTimeoutMs: 1000,
    responseTimeoutMs: 3000,
  }),
});

export const RoutesListSchema = z
  .array(RouteDefinitionSchema)
  .min(1, 'At least one route definition is required')
  .refine(
    (routes) => {
      const ids = new Set<string>();
      for (const route of routes) {
        if (ids.has(route.id)) {
          return false;
        }
        ids.add(route.id);
      }
      return true;
    },
    {
      message: 'All route IDs must be globally unique',
      path: ['routes'],
    }
  )
  .refine(
    (routes) => {
      const routeMethodMap = new Map<string, string>();
      for (const route of routes) {
        for (const method of route.methods) {
          const key = `${method}:${route.pathPrefix}`;
          if (routeMethodMap.has(key)) {
            return false;
          }
          routeMethodMap.set(key, route.id);
        }
      }
      return true;
    },
    {
      message: 'Route collision detected: multiple routes cannot define the same HTTP method and exact pathPrefix',
      path: ['routes'],
    }
  );

export const RoutesConfigSchema = z.object({
  routes: RoutesListSchema,
});

export const GatewayConfigSchema = z.object({
  server: ServerConfigSchema.default({}),
  redis: RedisConfigSchema.default({}),
  auth: AuthConfigSchema.optional(),
  routes: RoutesListSchema,
});

export type HttpMethod = z.infer<typeof HttpMethodSchema>;
export type AuthMode = z.infer<typeof AuthModeSchema>;
export type RateLimitFailurePolicy = z.infer<typeof RateLimitFailurePolicySchema>;
export type LogLevel = z.infer<typeof LogLevelSchema>;
export type LogFormat = z.infer<typeof LogFormatSchema>;
export type ServerConfig = z.infer<typeof ServerConfigSchema>;
export type RedisConfig = z.infer<typeof RedisConfigSchema>;
export type JwtAlgorithm = z.infer<typeof JwtAlgorithmSchema>;
export type RouteAuthPolicy = z.infer<typeof RouteAuthPolicySchema>;
export type RouteRateLimitPolicy = z.infer<typeof RouteRateLimitPolicySchema>;
export type RouteTimeoutPolicy = z.infer<typeof RouteTimeoutPolicySchema>;
export type RouteDefinition = z.infer<typeof RouteDefinitionSchema>;
export type GatewayConfig = z.infer<typeof GatewayConfigSchema>;
