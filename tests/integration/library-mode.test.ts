import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { createGatewayServer, RouteXGatewayServer } from '../../src/index.js';

describe('RouteX Library Mode (Programmatic SDK Integration)', () => {
  let upstreamServer: http.Server;
  let upstreamPort: number;
  let upstreamUrl: string;

  beforeAll(async () => {
    // Spin up an in-memory mock upstream HTTP server
    upstreamServer = http.createServer((req, res) => {
      if (req.url === '/api/v1/hello') {
        res.writeHead(200, {
          'content-type': 'application/json',
          'x-upstream-service': 'mock-api',
        });
        res.end(JSON.stringify({ message: 'Hello from programmatic upstream!' }));
        return;
      }
      if (req.url === '/api/v1/echo') {
        let body = '';
        req.on('data', (chunk) => {
          body += chunk;
        });
        req.on('end', () => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ received: body, echoed: true }));
        });
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not_found' }));
    });

    await new Promise<void>((resolve) => {
      upstreamServer.listen(0, '127.0.0.1', () => {
        const addr = upstreamServer.address() as { port: number };
        upstreamPort = addr.port;
        upstreamUrl = `http://127.0.0.1:${upstreamPort}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      upstreamServer.close(() => resolve());
    });
  });

  it('should instantiate RouteXGatewayServer purely in-memory without YAML configuration', async () => {
    const gateway = createGatewayServer({
      server: {
        host: '127.0.0.1',
        logLevel: 'silent',
      },
      redis: {
        enabled: false,
      },
      routes: [
        {
          id: 'mock-programmatic-route',
          pathPrefix: '/api/v1',
          upstream: upstreamUrl,
          stripPrefix: false,
          methods: ['GET', 'POST'],
        },
      ],
    });

    expect(gateway).toBeInstanceOf(RouteXGatewayServer);
    expect(gateway.config.routes).toHaveLength(1);
    expect(gateway.config.routes[0]?.id).toBe('mock-programmatic-route');

    // Verify sub-manager getters are exposed
    expect(gateway.router).toBeDefined();
    expect(gateway.poolManager).toBeDefined();
    expect(gateway.auth).toBeDefined();
    expect(gateway.rateLimit).toBeDefined();
    expect(gateway.cache).toBeDefined();
    expect(gateway.circuitBreakers).toBeDefined();
    expect(gateway.health).toBeDefined();
    expect(gateway.webSockets).toBeDefined();
    expect(gateway.fastifyInstance).toBeDefined();

    // Start server on ephemeral port
    const address = await gateway.listen(0, '127.0.0.1');
    expect(address).toMatch(/http:\/\/127\.0\.0\.1:\d+/);

    const match = address.match(/:(\d+)$/);
    const gatewayPort = Number(match![1]);

    try {
      // 1. Test GET request forwarded to upstream
      const res = await fetch(`http://127.0.0.1:${gatewayPort}/api/v1/hello`);
      expect(res.status).toBe(200);
      expect(res.headers.get('x-upstream-service')).toBe('mock-api');
      expect(res.headers.get('x-request-id')).toBeDefined();

      const data = await res.json();
      expect(data).toEqual({ message: 'Hello from programmatic upstream!' });

      // 2. Test POST request streaming to upstream
      const postRes = await fetch(`http://127.0.0.1:${gatewayPort}/api/v1/echo`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ping: 'pong' }),
      });
      expect(postRes.status).toBe(200);
      const postData = (await postRes.json()) as { echoed: boolean };
      expect(postData.echoed).toBe(true);

      // 3. Test built-in healthz endpoint
      const healthRes = await fetch(`http://127.0.0.1:${gatewayPort}/healthz`);
      expect(healthRes.status).toBe(200);
      const healthData = (await healthRes.json()) as { status: string; gateway: string };
      expect(healthData.status).toBe('ok');
      expect(healthData.gateway).toBe('RouteX');

      // 4. Test 404 Route Not Found envelope
      const notFoundRes = await fetch(`http://127.0.0.1:${gatewayPort}/non-existent`);
      expect(notFoundRes.status).toBe(404);
      const notFoundData = (await notFoundRes.json()) as { error: string };
      expect(notFoundData.error).toBe('ROUTE_NOT_FOUND');
    } finally {
      await gateway.close();
    }
  });

  it('should allow attaching custom handlers or hooks to underlying Fastify instance', async () => {
    const gateway = createGatewayServer({
      server: {
        host: '127.0.0.1',
        logLevel: 'silent',
      },
      redis: {
        enabled: false,
      },
      routes: [
        {
          id: 'mock-programmatic-route',
          pathPrefix: '/api/v1',
          upstream: upstreamUrl,
        },
      ],
    });

    // Custom hook on Fastify instance before ready
    gateway.fastifyInstance.get('/custom-embedded-route', async () => {
      return { embedded: true, library: 'routex' };
    });

    await gateway.listen(0, '127.0.0.1');
    const addr = gateway.fastifyInstance.server.address() as { port: number };
    const port = addr.port;

    try {
      const res = await fetch(`http://127.0.0.1:${port}/custom-embedded-route`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ embedded: true, library: 'routex' });
    } finally {
      await gateway.close();
    }
  });
});
