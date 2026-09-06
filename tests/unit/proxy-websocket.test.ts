import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import { ProxyRouter } from '../../src/proxy/router.js';
import { WebSocketProxyHandler, normalizeClientIp } from '../../src/proxy/websocket.js';
import type { RouteDefinition } from '../../src/types/index.js';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function computeAcceptKey(key: string): string {
  return crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
}

describe('WebSocketProxyHandler RFC 6455 Edge Proxy', () => {
  let upstreamServer: http.Server;
  let upstreamPort: number;
  let gatewayServer: http.Server;
  let gatewayPort: number;
  let wsHandler: WebSocketProxyHandler;
  let router: ProxyRouter;
  const openSockets = new Set<net.Socket>();

  beforeAll(async () => {
    // 1. Setup mock upstream server that responds to RFC 6455 upgrades
    upstreamServer = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('Upstream HTTP OK');
    });

    upstreamServer.on('connection', (socket) => {
      openSockets.add(socket);
      socket.on('close', () => openSockets.delete(socket));
    });

    upstreamServer.on('upgrade', (req, socket, head) => {
      const key = req.headers['sec-websocket-key'] as string;
      const accept = computeAcceptKey(key);
      const subprotocol = req.headers['sec-websocket-protocol'] as string | undefined;
      const extensions = req.headers['sec-websocket-extensions'] as string | undefined;

      const headers = [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${accept}`,
      ];

      if (subprotocol) {
        const first = subprotocol.split(',')[0]?.trim();
        if (first) {
          headers.push(`Sec-WebSocket-Protocol: ${first}`);
        }
      }
      if (extensions) {
        headers.push(`Sec-WebSocket-Extensions: ${extensions}`);
      }

      socket.write(headers.join('\r\n') + '\r\n\r\n');

      if (head && head.length > 0) {
        socket.write(head);
      }

      socket.on('data', (chunk) => {
        socket.write(chunk);
      });

      socket.on('end', () => {
        socket.end();
      });
    });

    await new Promise<void>((resolve) => {
      upstreamServer.listen(0, '127.0.0.1', () => {
        upstreamPort = (upstreamServer.address() as net.AddressInfo).port;
        resolve();
      });
    });

    // 2. Configure RouteX ProxyRouter
    const routes: RouteDefinition[] = [
      {
        id: 'ws-route',
        pathPrefix: '/ws',
        upstream: `http://127.0.0.1:${upstreamPort}`,
        stripPrefix: false,
        websocket: true,
        methods: ['GET'],
        auth: { mode: 'public', requiredRoles: [] },
        timeouts: { connectTimeoutMs: 1000, responseTimeoutMs: 2000 },
      },
      {
        id: 'http-only-route',
        pathPrefix: '/http-only',
        upstream: `http://127.0.0.1:${upstreamPort}`,
        stripPrefix: false,
        websocket: false,
        methods: ['GET'],
        auth: { mode: 'public', requiredRoles: [] },
        timeouts: { connectTimeoutMs: 1000, responseTimeoutMs: 2000 },
      },
      {
        id: 'rate-limited-ws',
        pathPrefix: '/ratelimited',
        upstream: `http://127.0.0.1:${upstreamPort}`,
        stripPrefix: false,
        websocket: true,
        methods: ['GET'],
        auth: { mode: 'public', requiredRoles: [] },
        rateLimit: {
          enabled: true,
          windowSec: 60,
          limit: 1,
          failurePolicy: 'fail-closed',
        },
        timeouts: { connectTimeoutMs: 1000, responseTimeoutMs: 2000 },
      },
    ];

    router = new ProxyRouter(routes);

    // Mock RateLimitManager that denies requests to /ratelimited
    const mockRateLimitManager = {
      checkIpRateLimit: async (_ip: string, route: RouteDefinition) => {
        if (route.id === 'rate-limited-ws') {
          return {
            allowed: false,
            limit: 1,
            remaining: 0,
            resetAt: Date.now() + 60000,
            retryAfterSec: 60,
          };
        }
        return {
          allowed: true,
          limit: 100,
          remaining: 99,
          resetAt: Date.now() + 60000,
          retryAfterSec: 0,
        };
      },
      formatHeaders: (res: any) => ({
        'X-RateLimit-Limit': String(res.limit),
        'X-RateLimit-Remaining': String(res.remaining),
        'X-RateLimit-Reset': String(res.resetAt),
        'Retry-After': String(res.retryAfterSec),
      }),
    };

    wsHandler = new WebSocketProxyHandler({
      router,
      rateLimitManager: mockRateLimitManager as any,
      defaultUpgradeTimeoutMs: 2000,
    });

    // 3. Setup gateway HTTP server
    gatewayServer = http.createServer();
    gatewayServer.on('connection', (socket) => {
      openSockets.add(socket);
      socket.on('close', () => openSockets.delete(socket));
    });

    gatewayServer.on('upgrade', (req, socket, head) => {
      wsHandler.handleUpgrade(req, socket, head).catch((_err) => {
        if (!socket.destroyed) socket.destroy();
      });
    });

    await new Promise<void>((resolve) => {
      gatewayServer.listen(0, '127.0.0.1', () => {
        gatewayPort = (gatewayServer.address() as net.AddressInfo).port;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await wsHandler.closeAll(200);
    for (const socket of openSockets) {
      if (!socket.destroyed) {
        socket.destroy();
      }
    }
    openSockets.clear();
    await new Promise<void>((resolve) => gatewayServer.close(() => resolve()));
    await new Promise<void>((resolve) => upstreamServer.close(() => resolve()));
  });

  it('should correctly normalize client IP using node:net', () => {
    expect(normalizeClientIp('127.0.0.1')).toBe('127.0.0.1');
    expect(normalizeClientIp('::ffff:127.0.0.1')).toBe('127.0.0.1');
    expect(normalizeClientIp('::1')).toBe('::1');
    expect(normalizeClientIp('2001:db8::1')).toBe('2001:db8::1');
    expect(normalizeClientIp(undefined)).toBe('127.0.0.1');
  });

  it('should successfully proxy RFC 6455 WebSocket upgrade and stream data', async () => {
    const key = crypto.randomBytes(16).toString('base64');
    const client = net.connect(gatewayPort, '127.0.0.1');
    openSockets.add(client);

    await new Promise<void>((resolve, reject) => {
      client.on('connect', () => {
        client.write(
          [
            'GET /ws/chat HTTP/1.1',
            `Host: 127.0.0.1:${gatewayPort}`,
            'Upgrade: websocket',
            'Connection: Upgrade',
            `Sec-WebSocket-Key: ${key}`,
            'Sec-WebSocket-Version: 13',
            '',
            '',
          ].join('\r\n')
        );
      });

      let responseBuffer = '';
      client.on('data', (chunk) => {
        responseBuffer += chunk.toString('utf8');
        if (responseBuffer.includes('101 Switching Protocols')) {
          expect(responseBuffer).toContain('Upgrade: websocket');
          expect(responseBuffer).toContain('Connection: Upgrade');
          expect(responseBuffer).toContain(`Sec-WebSocket-Accept: ${computeAcceptKey(key)}`);
          expect(wsHandler.activeTunnelCount).toBeGreaterThanOrEqual(1);
          client.destroy();
          resolve();
        }
      });

      client.on('error', reject);
    });
  });

  it('should reject upgrade on route without websocket enabled (400 Bad Request)', async () => {
    const key = crypto.randomBytes(16).toString('base64');
    const client = net.connect(gatewayPort, '127.0.0.1');
    openSockets.add(client);

    await new Promise<void>((resolve, reject) => {
      client.on('connect', () => {
        client.write(
          [
            'GET /http-only HTTP/1.1',
            `Host: 127.0.0.1:${gatewayPort}`,
            'Upgrade: websocket',
            'Connection: Upgrade',
            `Sec-WebSocket-Key: ${key}`,
            'Sec-WebSocket-Version: 13',
            '',
            '',
          ].join('\r\n')
        );
      });

      let response = '';
      client.on('data', (chunk) => {
        response += chunk.toString('utf8');
      });

      client.on('close', () => {
        expect(response).toContain('400 Bad Request');
        expect(response).toContain('does not allow WebSocket upgrade');
        resolve();
      });

      client.on('error', reject);
    });
  });

  it('should reject upgrade with missing Sec-WebSocket-Key (400 Bad Request)', async () => {
    const client = net.connect(gatewayPort, '127.0.0.1');
    openSockets.add(client);

    await new Promise<void>((resolve, reject) => {
      client.on('connect', () => {
        client.write(
          [
            'GET /ws HTTP/1.1',
            `Host: 127.0.0.1:${gatewayPort}`,
            'Upgrade: websocket',
            'Connection: Upgrade',
            '',
            '',
          ].join('\r\n')
        );
      });

      let response = '';
      client.on('data', (chunk) => {
        response += chunk.toString('utf8');
      });

      client.on('close', () => {
        expect(response).toContain('400 Bad Request');
        expect(response).toContain('Invalid or missing WebSocket Upgrade headers');
        resolve();
      });

      client.on('error', reject);
    });
  });

  it('should return 404 when route does not match', async () => {
    const key = crypto.randomBytes(16).toString('base64');
    const client = net.connect(gatewayPort, '127.0.0.1');
    openSockets.add(client);

    await new Promise<void>((resolve, reject) => {
      client.on('connect', () => {
        client.write(
          [
            'GET /nonexistent HTTP/1.1',
            `Host: 127.0.0.1:${gatewayPort}`,
            'Upgrade: websocket',
            'Connection: Upgrade',
            `Sec-WebSocket-Key: ${key}`,
            'Sec-WebSocket-Version: 13',
            '',
            '',
          ].join('\r\n')
        );
      });

      let response = '';
      client.on('data', (chunk) => {
        response += chunk.toString('utf8');
      });

      client.on('close', () => {
        expect(response).toContain('404 Not Found');
        resolve();
      });

      client.on('error', reject);
    });
  });

  it('should pass through Sec-WebSocket-Protocol negotiation', async () => {
    const key = crypto.randomBytes(16).toString('base64');
    const client = net.connect(gatewayPort, '127.0.0.1');
    openSockets.add(client);

    await new Promise<void>((resolve, reject) => {
      client.on('connect', () => {
        client.write(
          [
            'GET /ws/protocol-test HTTP/1.1',
            `Host: 127.0.0.1:${gatewayPort}`,
            'Upgrade: websocket',
            'Connection: Upgrade',
            `Sec-WebSocket-Key: ${key}`,
            'Sec-WebSocket-Version: 13',
            'Sec-WebSocket-Protocol: pulse.v1, json',
            '',
            '',
          ].join('\r\n')
        );
      });

      let response = '';
      client.on('data', (chunk) => {
        response += chunk.toString('utf8');
        if (response.includes('101 Switching Protocols')) {
          expect(response).toContain('Sec-WebSocket-Protocol: pulse.v1');
          client.destroy();
          resolve();
        }
      });

      client.on('error', reject);
    });
  });

  it('should pass through Sec-WebSocket-Extensions negotiation', async () => {
    const key = crypto.randomBytes(16).toString('base64');
    const client = net.connect(gatewayPort, '127.0.0.1');
    openSockets.add(client);

    await new Promise<void>((resolve, reject) => {
      client.on('connect', () => {
        client.write(
          [
            'GET /ws/ext-test HTTP/1.1',
            `Host: 127.0.0.1:${gatewayPort}`,
            'Upgrade: websocket',
            'Connection: Upgrade',
            `Sec-WebSocket-Key: ${key}`,
            'Sec-WebSocket-Version: 13',
            'Sec-WebSocket-Extensions: permessage-deflate; client_max_window_bits',
            '',
            '',
          ].join('\r\n')
        );
      });

      let response = '';
      client.on('data', (chunk) => {
        response += chunk.toString('utf8');
        if (response.includes('101 Switching Protocols')) {
          expect(response).toContain('Sec-WebSocket-Extensions: permessage-deflate; client_max_window_bits');
          client.destroy();
          resolve();
        }
      });

      client.on('error', reject);
    });
  });

  it('should forward client head bytes with byte fidelity to upstream', async () => {
    const key = crypto.randomBytes(16).toString('base64');
    const client = net.connect(gatewayPort, '127.0.0.1');
    openSockets.add(client);
    const headPayload = 'PING_FRAME_HEAD_BYTES';

    await new Promise<void>((resolve, reject) => {
      client.on('connect', () => {
        client.write(
          [
            'GET /ws/head-test HTTP/1.1',
            `Host: 127.0.0.1:${gatewayPort}`,
            'Upgrade: websocket',
            'Connection: Upgrade',
            `Sec-WebSocket-Key: ${key}`,
            'Sec-WebSocket-Version: 13',
            '',
            '',
          ].join('\r\n') + headPayload
        );
      });

      let response = '';
      client.on('data', (chunk) => {
        response += chunk.toString('utf8');
        if (response.includes(headPayload)) {
          expect(response).toContain('101 Switching Protocols');
          client.destroy();
          resolve();
        }
      });

      client.on('error', reject);
    });
  });

  it('should return 502 Bad Gateway if upstream is unreachable', async () => {
    const deadRoutes: RouteDefinition[] = [
      {
        id: 'dead-upstream-route',
        pathPrefix: '/dead',
        upstream: 'http://127.0.0.1:49999',
        stripPrefix: false,
        websocket: true,
        methods: ['GET'],
        auth: { mode: 'public', requiredRoles: [] },
        timeouts: { connectTimeoutMs: 200, responseTimeoutMs: 500 },
      },
    ];
    const deadRouter = new ProxyRouter(deadRoutes);
    const deadHandler = new WebSocketProxyHandler({
      router: deadRouter,
      defaultUpgradeTimeoutMs: 500,
    });

    const deadServer = http.createServer();
    deadServer.on('connection', (s) => openSockets.add(s));
    deadServer.on('upgrade', (req, socket, head) => {
      deadHandler.handleUpgrade(req, socket, head);
    });

    await new Promise<void>((resolve) => deadServer.listen(0, '127.0.0.1', () => resolve()));
    const deadPort = (deadServer.address() as net.AddressInfo).port;

    const key = crypto.randomBytes(16).toString('base64');
    const client = net.connect(deadPort, '127.0.0.1');
    openSockets.add(client);

    await new Promise<void>((resolve, reject) => {
      client.on('connect', () => {
        client.write(
          [
            'GET /dead HTTP/1.1',
            `Host: 127.0.0.1:${deadPort}`,
            'Upgrade: websocket',
            'Connection: Upgrade',
            `Sec-WebSocket-Key: ${key}`,
            'Sec-WebSocket-Version: 13',
            '',
            '',
          ].join('\r\n')
        );
      });

      let response = '';
      client.on('data', (chunk) => {
        response += chunk.toString('utf8');
      });

      client.on('close', () => {
        expect(response).toContain('502 Bad Gateway');
        deadServer.close();
        resolve();
      });

      client.on('error', reject);
    });
  });

  it('should enforce IP rate limiting on WebSocket upgrades (429 Too Many Requests)', async () => {
    const key = crypto.randomBytes(16).toString('base64');
    const client = net.connect(gatewayPort, '127.0.0.1');
    openSockets.add(client);

    await new Promise<void>((resolve, reject) => {
      client.on('connect', () => {
        client.write(
          [
            'GET /ratelimited/ws HTTP/1.1',
            `Host: 127.0.0.1:${gatewayPort}`,
            'Upgrade: websocket',
            'Connection: Upgrade',
            `Sec-WebSocket-Key: ${key}`,
            'Sec-WebSocket-Version: 13',
            '',
            '',
          ].join('\r\n')
        );
      });

      let response = '';
      client.on('data', (chunk) => {
        response += chunk.toString('utf8');
      });

      client.on('close', () => {
        expect(response).toContain('429 Too Many Requests');
        expect(response).toContain('X-RateLimit-Remaining: 0');
        expect(response).toContain('Retry-After: 60');
        resolve();
      });

      client.on('error', reject);
    });
  });
});
