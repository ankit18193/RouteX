import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { loadGatewayConfig, loadRoutesConfig } from '../../src/config/loader.js';
import * as ConfigModule from '../../src/config/index.js';
import { ConfigurationError } from '../../src/errors/gateway-error.js';

describe('Configuration Loader', () => {
  const fixturesDir = resolve(process.cwd(), 'tests/fixtures');

  it('should export all config symbols from index.ts', () => {
    expect(ConfigModule.loadGatewayConfig).toBeDefined();
    expect(ConfigModule.loadRoutesConfig).toBeDefined();
    expect(ConfigModule.GatewayConfigSchema).toBeDefined();
  });

  it('should load valid gateway and routes fixtures', () => {
    const config = loadGatewayConfig({
      configPath: `${fixturesDir}/valid-gateway.config.yaml`,
      routesPath: `${fixturesDir}/valid-routes.yaml`,
    });

    expect(config.server.port).toBe(9000);
    expect(config.server.host).toBe('127.0.0.1');
    expect(config.server.logLevel).toBe('debug');
    expect(config.redis.port).toBe(6380);
    expect(config.redis.password).toBe('test-password');
    expect(config.routes).toHaveLength(2);
    expect(config.routes[0]?.id).toBe('test_service_1');
    expect(config.routes[0]?.stripPrefix).toBe(true);
    expect(config.routes[0]?.rateLimit?.failurePolicy).toBe('fail-closed');
  });

  it('should preserve embedded routes from unified config without overwriting from default routes.yaml', () => {
    const config = loadGatewayConfig({
      configPath: `${fixturesDir}/unified-gateway.config.yaml`,
    });

    expect(config.server.port).toBe(8888);
    expect(config.routes).toHaveLength(1);
    expect(config.routes[0]?.id).toBe('embedded_route_1');
    expect(config.routes[0]?.pathPrefix).toBe('/embedded/v1');
  });

  it('should allow explicit routesPath to override embedded routes', () => {
    const config = loadGatewayConfig({
      configPath: `${fixturesDir}/unified-gateway.config.yaml`,
      routesPath: `${fixturesDir}/valid-routes.yaml`,
    });

    expect(config.server.port).toBe(8888);
    expect(config.routes).toHaveLength(2);
    expect(config.routes[0]?.id).toBe('test_service_1');
  });

  it('should override configuration with environment variables', () => {
    const customEnv: Record<string, string> = {
      PORT: '9999',
      HOST: '10.0.0.5',
      LOG_LEVEL: 'warn',
      LOG_FORMAT: 'pretty',
      REDIS_HOST: 'redis.prod',
      REDIS_PORT: '6399',
      REDIS_PASSWORD: 'prod-password',
    };

    const config = loadGatewayConfig({
      configPath: `${fixturesDir}/valid-gateway.config.yaml`,
      routesPath: `${fixturesDir}/valid-routes.yaml`,
      env: customEnv,
    });

    expect(config.server.port).toBe(9999);
    expect(config.server.host).toBe('10.0.0.5');
    expect(config.server.logLevel).toBe('warn');
    expect(config.server.logFormat).toBe('pretty');
    expect(config.redis.host).toBe('redis.prod');
    expect(config.redis.port).toBe(6399);
    expect(config.redis.password).toBe('prod-password');
  });

  it('should throw ConfigurationError for invalid routes fixture', () => {
    expect(() =>
      loadGatewayConfig({
        configPath: `${fixturesDir}/valid-gateway.config.yaml`,
        routesPath: `${fixturesDir}/invalid-routes.yaml`,
      })
    ).toThrow(ConfigurationError);
  });

  it('should throw ConfigurationError if no routes are provided anywhere', () => {
    expect(() =>
      loadGatewayConfig({
        configPath: `${fixturesDir}/valid-gateway.config.yaml`,
        routesPath: `${fixturesDir}/non-existent-routes.yaml`,
      })
    ).toThrow(ConfigurationError);
  });

  it('should throw ConfigurationError when YAML file has syntax errors', () => {
    expect(() =>
      loadGatewayConfig({
        configPath: `${fixturesDir}/malformed-yaml.yaml`,
      })
    ).toThrow(/Syntax error while parsing YAML configuration file/);
  });

  it('should load standalone routes via loadRoutesConfig', () => {
    const routes = loadRoutesConfig(`${fixturesDir}/valid-routes.yaml`);
    expect(routes).toHaveLength(2);
    expect(routes[0]?.id).toBe('test_service_1');
    expect(routes[1]?.id).toBe('test_service_2');
  });

  it('should throw ConfigurationError on non-existent standalone routes file', () => {
    expect(() =>
      loadRoutesConfig(`${fixturesDir}/missing-routes-file.yaml`)
    ).toThrow(ConfigurationError);
  });
});
