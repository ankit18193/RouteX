import { describe, it, expect } from 'vitest';
import * as RouteX from '../../src/index.js';
import * as MockServices from '../../mock-services/index.js';

describe('RouteX Root Module Exports', () => {
  it('should export all public Phase 1, Phase 2, and Phase 3 APIs from root entrypoint', () => {
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
