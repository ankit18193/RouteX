import { describe, it, expect } from 'vitest';
import * as RouteX from '../../src/index.js';
import * as MockServices from '../../mock-services/index.js';

describe('RouteX Root Module Exports', () => {
  it('should export all public Phase 1 APIs from root entrypoint', () => {
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
