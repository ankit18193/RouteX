import { describe, it, expect } from 'vitest';
import * as RouteX from '../../src/index.js';
import * as MockServices from '../../mock-services/index.js';

describe('RouteX Root Module Exports', () => {
  it('should export all public Phase 1, Phase 2, Phase 3, Phase 4, and Phase 5 APIs from root entrypoint', () => {
    // Phase 1 exports
    expect(RouteX.GatewayConfigSchema).toBeDefined();
    expect(RouteX.loadGatewayConfig).toBeDefined();
    expect(RouteX.loadRoutesConfig).toBeDefined();
    expect(RouteX.createErrorEnvelope).toBeDefined();
    expect(RouteX.GatewayError).toBeDefined();
    expect(RouteX.createLogger).toBeDefined();
    expect(RouteX.createRequestLogger).toBeDefined();
    expect(RouteX.logAccess).toBeDefined();
    expect(RouteX.startTimer).toBeDefined();
    expect(RouteX.calculateLatencyBreakdown).toBeDefined();
    expect(RouteX.generateRequestId).toBeDefined();
    expect(RouteX.normalizeRequestId).toBeDefined();

    // Phase 3 proxy & server exports
    expect(RouteX.ProxyRouter).toBeDefined();
    expect(RouteX.UpstreamPoolManager).toBeDefined();
    expect(RouteX.handleProxyStream).toBeDefined();
    expect(RouteX.sanitizeRequestHeaders).toBeDefined();
    expect(RouteX.sanitizeResponseHeaders).toBeDefined();
    expect(RouteX.RouteXGatewayServer).toBeDefined();
    expect(RouteX.createGatewayServer).toBeDefined();

    // Phase 4 auth exports
    expect(RouteX.extractCredentials).toBeDefined();
    expect(RouteX.JwtVerifier).toBeDefined();
    expect(RouteX.createJwtVerifier).toBeDefined();
    expect(RouteX.ApiKeyAuthenticator).toBeDefined();
    expect(RouteX.createApiKeyAuthenticator).toBeDefined();
    expect(RouteX.ApiKeyCache).toBeDefined();
    expect(RouteX.InMemoryApiKeyStore).toBeDefined();
    expect(RouteX.AuthManager).toBeDefined();
    expect(RouteX.createAuthManager).toBeDefined();
    expect(RouteX.ANONYMOUS_AUTH_CONTEXT).toBeDefined();

    // Phase 5 rate limit exports
    expect(RouteX.RedisClient).toBeDefined();
    expect(RouteX.createRedisClient).toBeDefined();
    expect(RouteX.SlidingWindowRateLimiter).toBeDefined();
    expect(RouteX.createSlidingWindowRateLimiter).toBeDefined();
    expect(RouteX.RateLimitManager).toBeDefined();
    expect(RouteX.createRateLimitManager).toBeDefined();
    expect(RouteX.generateRateLimitKey).toBeDefined();
    expect(RouteX.hashRateLimitIdentifier).toBeDefined();
    expect(RouteX.SLIDING_WINDOW_LUA_SCRIPT).toBeDefined();
  });

  it('should export mock service factories and JWT test helpers', () => {
    expect(MockServices.buildUserService).toBeDefined();
    expect(MockServices.buildChatService).toBeDefined();
    expect(MockServices.generateTestJwt).toBeDefined();
    expect(MockServices.verifyTestJwt).toBeDefined();
    expect(MockServices.TEST_JWT_SECRET).toBeDefined();
    expect(MockServices.TEST_RSA_PUBLIC_KEY).toBeDefined();
  });
});
