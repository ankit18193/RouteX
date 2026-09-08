import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import { RouteXGatewayServer, createGatewayServer } from '../../src/server/gateway-server.js';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
function computeAcceptKey(key: string): string {
  return crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
}

describe('RouteX Embedded Mode ↔ Host HTTP Server Integration', () => {
  let mockUpstreamHttp: http.Server;
  let mockUpstreamHttpPort: number;

  let mockUpstreamWs: http.Server;
  let mockUpstreamWsPort: number;

  let hostServer: http.Server;
  let hostPort: number;

  let gateway: RouteXGatewayServer;
  const activeSockets = new Set<net.Socket>();

  function trackSockets(server: http.Server) {
    server.on('connection', (s) => {
      activeSockets.add(s);
      s.on('close', () => activeSockets.delete(s));
    });
  }

  beforeAll(async () => {
    // 1. Mock upstream HTTP service
    mockUpstreamHttp = http.createServer((req, res) => {
    trackSockets(mockUpstreamHttp);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ source: 'upstream_http', path: req.url }));
    });
    await new Promise<void>((resolve) => mockUpstreamHttp.listen(0, '127.0.0.1', () => resolve()));
    mockUpstreamHttpPort = (mockUpstreamHttp.address() as net.AddressInfo).port;

    // 2. Mock upstream WebSocket service
    mockUpstreamWs = http.createServer();
    trackSockets(mockUpstreamWs);
    mockUpstreamWs.on('upgrade', (req, socket, head) => {
      const key = req.headers['sec-websocket-key'] as string;
      const accept = computeAcceptKey(key);
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
      );
      if (head && head.length > 0) {
        socket.write(head);
      }
      socket.on('data', (chunk) => {
        socket.write(chunk);
      });
    });
    await new Promise<void>((resolve) => mockUpstreamWs.listen(0, '127.0.0.1', () => resolve()));
    mockUpstreamWsPort = (mockUpstreamWs.address() as net.AddressInfo).port;

    // 3. Create embedded RouteX Gateway
    gateway = createGatewayServer(
      {
        server: {
          port: 8080,
          host: '127.0.0.1',
          requestTimeoutMs: 5000,
          headersTimeoutMs: 6000,
          maxHeaderSize: 16384,
          logLevel: 'silent',
          logFormat: 'json',
        },
        redis: { enabled: false },
        routes: [
          {
            id: 'upstream-api',
            pathPrefix: '/api',
            upstream: `http://127.0.0.1:${mockUpstreamHttpPort}`,
            methods: ['GET', 'POST'],
          },
          {
            id: 'upstream-ws',
            pathPrefix: '/ws',
            upstream: `http://127.0.0.1:${mockUpstreamWsPort}`,
            websocket: true,
            methods: ['GET'],
          },
        ],
      },
      { embedded: true }
    );
    await gateway.ready();

    // 4. Create Host HTTP server and wire RouteX embedded dispatchers
    hostServer = http.createServer(async (req, res) => {
    trackSockets(hostServer);
      const handled = await gateway.handleRequest(req, res);
      if (handled) return;

      // Host fallback handlers
      if (req.url === '/host/metrics') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('host_metrics_ok');
        return;
      }

      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('host_404');
    });

    hostServer.on('upgrade', async (req, socket, head) => {
      const handled = await gateway.handleUpgrade(req, socket, head);
      if (handled) return;

      // Host fallback WebSocket upgrade
      if (req.url === '/host-ws') {
        const key = req.headers['sec-websocket-key'] as string;
        const accept = computeAcceptKey(key);
        socket.write(
          'HTTP/1.1 101 Switching Protocols\r\n' +
          'Upgrade: websocket\r\n' +
          'Connection: Upgrade\r\n' +
          `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
        );
        socket.on('data', (chunk) => socket.write(chunk));
        return;
      }

      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
    });

    await new Promise<void>((resolve) => hostServer.listen(0, '127.0.0.1', () => resolve()));
    hostPort = (hostServer.address() as net.AddressInfo).port;
  });

  afterAll(async () => {
    for (const s of activeSockets) {
      if (!s.destroyed) s.destroy();
    }
    activeSockets.clear();

    await Promise.all([
      new Promise<void>((r) => (hostServer ? hostServer.close(() => r()) : r())),
      new Promise<void>((r) => (mockUpstreamHttp ? mockUpstreamHttp.close(() => r()) : r())),
      new Promise<void>((r) => (mockUpstreamWs ? mockUpstreamWs.close(() => r()) : r())),
    ]);
  });

  it('1. should proxy matched HTTP request via RouteX and return upstream response', async () => {
    const res = await fetch(`http://127.0.0.1:${hostPort}/api/users`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { source: string; path: string };
    expect(body.source).toBe('upstream_http');
    expect(body.path).toBe('/api/users');
  });

  it('2. should fall through on unmatched HTTP request and execute host handler', async () => {
    const res = await fetch(`http://127.0.0.1:${hostPort}/host/metrics`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toBe('host_metrics_ok');
  });

  it('3. should serve RouteX probe /gateway/healthz through handleRequest', async () => {
    const res = await fetch(`http://127.0.0.1:${hostPort}/gateway/healthz`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { gateway: string; status: string };
    expect(body.gateway).toBe('RouteX');
    expect(body.status).toBe('ok');
  });

  it('4. should proxy matched WebSocket upgrade to upstream WebSocket server', async () => {
    const socket = net.createConnection({ port: hostPort, host: '127.0.0.1' });
    const secKey = crypto.randomBytes(16).toString('base64');

    const upgradeResponse = await new Promise<string>((resolve, reject) => {
      socket.on('connect', () => {
        socket.write(
          'GET /ws/chat HTTP/1.1\r\n' +
          `Host: 127.0.0.1:${hostPort}\r\n` +
          'Upgrade: websocket\r\n' +
          'Connection: Upgrade\r\n' +
          `Sec-WebSocket-Key: ${secKey}\r\n` +
          'Sec-WebSocket-Version: 13\r\n\r\n'
        );
      });

      socket.once('data', (data) => {
        resolve(data.toString('utf-8'));
      });
      socket.on('error', reject);
    });

    expect(upgradeResponse).toContain('101 Switching Protocols');
    expect(upgradeResponse).toContain(`Sec-WebSocket-Accept: ${computeAcceptKey(secKey)}`);

    // Verify duplex communication
    const echoData = 'echo_payload_test';
    const echoed = await new Promise<string>((resolve) => {
      socket.once('data', (data) => resolve(data.toString('utf-8')));
      socket.write(echoData);
    });
    expect(echoed).toBe(echoData);

    socket.destroy();
  });

  it('5. should fall through on unmatched WebSocket upgrade and let host handle it', async () => {
    const socket = net.createConnection({ port: hostPort, host: '127.0.0.1' });
    const secKey = crypto.randomBytes(16).toString('base64');

    const upgradeResponse = await new Promise<string>((resolve, reject) => {
      socket.on('connect', () => {
        socket.write(
          'GET /host-ws HTTP/1.1\r\n' +
          `Host: 127.0.0.1:${hostPort}\r\n` +
          'Upgrade: websocket\r\n' +
          'Connection: Upgrade\r\n' +
          `Sec-WebSocket-Key: ${secKey}\r\n` +
          'Sec-WebSocket-Version: 13\r\n\r\n'
        );
      });

      socket.once('data', (data) => {
        resolve(data.toString('utf-8'));
      });
      socket.on('error', reject);
    });

    expect(upgradeResponse).toContain('101 Switching Protocols');
    expect(upgradeResponse).toContain(`Sec-WebSocket-Accept: ${computeAcceptKey(secKey)}`);

    socket.destroy();
  });

  it('6. should close RouteX without terminating the host HTTP server', async () => {
    await gateway.close();

    // Verify host server is STILL listening and functioning
    const res = await fetch(`http://127.0.0.1:${hostPort}/host/metrics`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('host_metrics_ok');
  });
});
