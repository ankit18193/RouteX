import { describe, it, expect, afterEach } from 'vitest';
import { RouteXGatewayServer, createGatewayServer } from '../../src/server/gateway-server.js';
import type { GatewayConfigInput } from '../../src/types/index.js';

describe('RouteX Embedded Gateway — Unit Tests', () => {
  let gateway: RouteXGatewayServer | undefined;

  const testConfig: GatewayConfigInput = {
    server: {
      port: 8080,
      host: '127.0.0.1',
      requestTimeoutMs: 5000,
      headersTimeoutMs: 6000,
      maxHeaderSize: 16384,
      logLevel: 'silent',
      logFormat: 'json',
    },
    redis: {
      enabled: false,
    },
    routes: [
      {
        id: 'test-http',
        pathPrefix: '/api',
        upstream: 'http://127.0.0.1:9999',
        methods: ['GET', 'POST'],
      },
      {
        id: 'test-ws',
        pathPrefix: '/ws',
        upstream: 'http://127.0.0.1:9998',
        websocket: true,
        methods: ['GET'],
      },
    ],
  };

  afterEach(async () => {
    if (gateway) {
      await gateway.close();
      gateway = undefined;
    }
  });

  it('should construct with embedded: true and record isEmbedded', () => {
    gateway = createGatewayServer(testConfig, { embedded: true });
    expect(gateway.isEmbedded).toBe(true);
  });

  it('should initialize via ready() without binding any network port', async () => {
    gateway = createGatewayServer(testConfig, { embedded: true });
    await gateway.ready();

    expect(gateway.fastifyInstance.server.listening).toBe(false);
  });

  it('should throw an error if listen() is called in embedded mode', async () => {
    gateway = createGatewayServer(testConfig, { embedded: true });
    await expect(gateway.listen(0)).rejects.toThrow(
      'RouteXGatewayServer.listen() cannot be called when embedded mode is enabled.'
    );
  });

  it('should accurately inspect routes via matchRoute()', () => {
    gateway = createGatewayServer(testConfig, { embedded: true });

    const httpMatch = gateway.matchRoute('/api/users', 'GET');
    expect(httpMatch.matched).toBe(true);
    if (httpMatch.matched) {
      expect(httpMatch.route.id).toBe('test-http');
      expect(httpMatch.route.websocket).toBeFalsy();
    }

    const wsMatch = gateway.matchRoute('/ws/chat', 'GET');
    expect(wsMatch.matched).toBe(true);
    if (wsMatch.matched) {
      expect(wsMatch.route.id).toBe('test-ws');
      expect(wsMatch.route.websocket).toBe(true);
    }

    const unmatch = gateway.matchRoute('/metrics', 'GET');
    expect(unmatch.matched).toBe(false);
  });

  it('should close gracefully in embedded mode without throwing', async () => {
    gateway = createGatewayServer(testConfig, { embedded: true });
    await gateway.ready();
    await expect(gateway.close()).resolves.toBeUndefined();
  });
});
