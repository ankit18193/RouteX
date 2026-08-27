import { describe, it, expect } from 'vitest';
import * as RouteX from '../../src/index.js';

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
});
