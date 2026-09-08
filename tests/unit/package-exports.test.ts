import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import * as RouteXRoot from '../../src/index.js';
import * as RouteXConfig from '../../src/config/index.js';
import * as RouteXServer from '../../src/server/index.js';
import * as RouteXTypes from '../../src/types/index.js';
import * as RouteXErrors from '../../src/errors/index.js';
import * as RouteXAuth from '../../src/auth/index.js';
import * as RouteXRateLimit from '../../src/rate-limit/index.js';
import * as RouteXCache from '../../src/cache/index.js';
import * as RouteXCircuitBreaker from '../../src/circuit-breaker/index.js';
import * as RouteXProxy from '../../src/proxy/index.js';
import * as RouteXLogger from '../../src/logger/index.js';
import * as RouteXUtils from '../../src/utils/index.js';

describe('RouteX Package Exports & Structure', () => {
  it('should export core server and gateway APIs from the root entrypoint', () => {
    expect(RouteXRoot.RouteXGatewayServer).toBeDefined();
    expect(RouteXRoot.createGatewayServer).toBeDefined();
    expect(typeof RouteXRoot.createGatewayServer).toBe('function');
    expect(RouteXRoot.GatewayConfigSchema).toBeDefined();
    expect(RouteXRoot.loadGatewayConfig).toBeDefined();
  });

  it('should export all public submodules corresponding to package exports mapping', () => {
    // Config submodule
    expect(RouteXConfig.GatewayConfigSchema).toBeDefined();
    expect(RouteXConfig.loadGatewayConfig).toBeDefined();
    expect(RouteXConfig.loadRoutesConfig).toBeDefined();

    // Server submodule
    expect(RouteXServer.RouteXGatewayServer).toBeDefined();
    expect(RouteXServer.createGatewayServer).toBeDefined();

    // Errors submodule
    expect(RouteXErrors.GatewayError).toBeDefined();
    expect(RouteXErrors.GatewayErrorCode).toBeDefined();
    expect(RouteXErrors.createErrorEnvelope).toBeDefined();

    // Auth submodule
    expect(RouteXAuth.AuthManager).toBeDefined();
    expect(RouteXAuth.createAuthManager).toBeDefined();
    expect(RouteXAuth.JwtVerifier).toBeDefined();
    expect(RouteXAuth.ApiKeyAuthenticator).toBeDefined();

    // Rate limit submodule
    expect(RouteXRateLimit.RateLimitManager).toBeDefined();
    expect(RouteXRateLimit.RedisClient).toBeDefined();
    expect(RouteXRateLimit.SlidingWindowRateLimiter).toBeDefined();

    // Cache submodule
    expect(RouteXCache.CacheManager).toBeDefined();
    expect(RouteXCache.RedisCacheStore).toBeDefined();
    expect(RouteXCache.SingleFlightGroup).toBeDefined();

    // Circuit breaker submodule
    expect(RouteXCircuitBreaker.CircuitBreaker).toBeDefined();
    expect(RouteXCircuitBreaker.CircuitManager).toBeDefined();

    // Proxy submodule
    expect(RouteXProxy.ProxyRouter).toBeDefined();
    expect(RouteXProxy.UpstreamPoolManager).toBeDefined();
    expect(RouteXProxy.WebSocketProxyHandler).toBeDefined();
    expect(RouteXProxy.UpstreamHealthTracker).toBeDefined();

    // Logger submodule
    expect(RouteXLogger.createLogger).toBeDefined();
    expect(RouteXLogger.logAccess).toBeDefined();

    // Types submodule
    expect(RouteXTypes).toBeDefined();

    // Utils submodule
    expect(RouteXUtils.normalizeRequestId).toBeDefined();
    expect(RouteXUtils.calculateLatencyBreakdown).toBeDefined();
  });

  it('should define a valid package.json manifest with types, exports, files, and scripts', () => {
    const pkgPath = resolve(process.cwd(), 'package.json');
    const pkgContent = JSON.parse(readFileSync(pkgPath, 'utf-8'));

    expect(['routex', '@ankit18193/routex-gateway']).toContain(pkgContent.name);
    expect(pkgContent.type).toBe('module');
    expect(pkgContent.main).toBe('dist/src/index.js');
    expect(pkgContent.types).toBe('dist/src/index.d.ts');

    // Verify exports map structure
    expect(pkgContent.exports).toBeDefined();
    expect(pkgContent.exports['.']).toEqual({
      types: './dist/src/index.d.ts',
      import: './dist/src/index.js',
    });

    const expectedSubpaths = [
      './config',
      './server',
      './types',
      './errors',
      './auth',
      './rate-limit',
      './cache',
      './circuit-breaker',
      './proxy',
      './logger',
      './utils',
    ];

    for (const subpath of expectedSubpaths) {
      expect(pkgContent.exports[subpath]).toBeDefined();
      expect(pkgContent.exports[subpath].types).toMatch(new RegExp(`^\\./dist/src/`));
      expect(pkgContent.exports[subpath].import).toMatch(new RegExp(`^\\./dist/src/`));
    }

    // Verify files array isolates payload
    expect(pkgContent.files).toContain('dist/src');
    expect(pkgContent.files).toContain('README.md');
    expect(pkgContent.files).toContain('LICENSE');

    // Verify scripts
    expect(pkgContent.scripts.dev).toBeDefined();
    expect(pkgContent.scripts.start).toBeDefined();
    expect(pkgContent.scripts.build).toBeDefined();
    expect(pkgContent.scripts.prepack).toBe('npm run build');

    // Verify LICENSE file exists
    const licensePath = resolve(process.cwd(), 'LICENSE');
    expect(existsSync(licensePath)).toBe(true);
  });
});
