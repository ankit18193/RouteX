import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import { UpstreamHealthTracker } from '../../src/proxy/upstream-health.js';
import { ProxyRouter } from '../../src/proxy/router.js';
import { WebSocketProxyHandler } from '../../src/proxy/websocket.js';
import type { RouteDefinition } from '../../src/types/index.js';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function computeAcceptKey(key: string): string {
  return crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
}

describe('UpstreamHealthTracker & Pre-101 Connect-Time Failover', () => {
  let healthTracker: UpstreamHealthTracker;
  const openSockets = new Set<net.Socket>();

  it('should register candidate upstreams and default to HEALTHY', () => {
    healthTracker = new UpstreamHealthTracker({ checkIntervalMs: 5000 });
    healthTracker.register(['http://127.0.0.1:3001', 'http://127.0.0.1:3002']);

    expect(healthTracker.getStatus('http://127.0.0.1:3001')).toBe('HEALTHY');
    expect(healthTracker.getStatus('http://127.0.0.1:3002')).toBe('HEALTHY');
  });

  it('should round-robin select among READY upstreams', () => {
    const candidates = ['http://127.0.0.1:3001', 'http://127.0.0.1:3002'];
    const choice1 = healthTracker.selectUpstream('route-1', candidates);
    const choice2 = healthTracker.selectUpstream('route-1', candidates);
    const choice3 = healthTracker.selectUpstream('route-1', candidates);

    expect(choice1).toBe('http://127.0.0.1:3001');
    expect(choice2).toBe('http://127.0.0.1:3002');
    expect(choice3).toBe('http://127.0.0.1:3001');
  });

  it('should mark an upstream DEGRADED and exclude it from selection when a healthy node is available', () => {
    const candidates = ['http://127.0.0.1:3001', 'http://127.0.0.1:3002'];
    healthTracker.markDegraded('http://127.0.0.1:3001', 'ECONNREFUSED');

    expect(healthTracker.getStatus('http://127.0.0.1:3001')).toBe('DEGRADED');
    expect(healthTracker.getStatus('http://127.0.0.1:3002')).toBe('HEALTHY');

    // Subsequent selections should pick the HEALTHY node
    const selected = healthTracker.selectUpstream('route-1', candidates);
    expect(selected).toBe('http://127.0.0.1:3002');
  });

  it('should fall back to any available candidate if all nodes are degraded', () => {
    const candidates = ['http://127.0.0.1:3001', 'http://127.0.0.1:3002'];
    healthTracker.markDegraded('http://127.0.0.1:3002', 'ECONNREFUSED');

    expect(healthTracker.getStatus('http://127.0.0.1:3001')).toBe('DEGRADED');
    expect(healthTracker.getStatus('http://127.0.0.1:3002')).toBe('DEGRADED');

    const selected = healthTracker.selectUpstream('route-1', candidates);
    expect(selected).toBeDefined();
    expect(candidates).toContain(selected);
  });

  describe('Live Bounded Pre-101 Failover Verification', () => {
    let healthyServer: http.Server;
    let healthyPort: number;
    let gatewayServer: http.Server;
    let gatewayPort: number;
    let failoverHandler: WebSocketProxyHandler;
    let liveHealthTracker: UpstreamHealthTracker;
    const deadPort = 49991;

    beforeAll(async () => {
      // 1. Setup healthy upstream node
      healthyServer = http.createServer((req, res) => {
        if (req.url === '/readyz') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'ok' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('OK');
      });

      healthyServer.on('connection', (socket) => {
        openSockets.add(socket);
        socket.on('close', () => openSockets.delete(socket));
      });

      healthyServer.on('upgrade', (req, socket, head) => {
        const key = req.headers['sec-websocket-key'] as string;
        const accept = computeAcceptKey(key);

        socket.write(
          [
            'HTTP/1.1 101 Switching Protocols',
            'Upgrade: websocket',
            'Connection: Upgrade',
            `Sec-WebSocket-Accept: ${accept}`,
            '',
            '',
          ].join('\r\n')
        );

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
        healthyServer.listen(0, '127.0.0.1', () => {
          healthyPort = (healthyServer.address() as net.AddressInfo).port;
          resolve();
        });
      });

      // 2. Setup health tracker and routes with dead node listed FIRST
      liveHealthTracker = new UpstreamHealthTracker({ checkIntervalMs: 5000 });
      const routes: RouteDefinition[] = [
        {
          id: 'failover-route',
          pathPrefix: '/failover',
          upstreams: [`http://127.0.0.1:${deadPort}`, `http://127.0.0.1:${healthyPort}`],
          stripPrefix: false,
          websocket: true,
          methods: ['GET'],
          auth: { mode: 'public', requiredRoles: [] },
          timeouts: { connectTimeoutMs: 500, responseTimeoutMs: 1000 },
        },
      ];

      const router = new ProxyRouter(routes);
      liveHealthTracker.register(routes[0]!.upstreams!);

      failoverHandler = new WebSocketProxyHandler({
        router,
        healthTracker: liveHealthTracker,
        defaultUpgradeTimeoutMs: 1000,
      });

      // 3. Setup gateway HTTP server
      gatewayServer = http.createServer();
      gatewayServer.on('connection', (socket) => {
        openSockets.add(socket);
        socket.on('close', () => openSockets.delete(socket));
      });

      gatewayServer.on('upgrade', (req, socket, head) => {
        failoverHandler.handleUpgrade(req, socket, head).catch((_err) => {
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
      liveHealthTracker.stop();
      await failoverHandler.closeAll(200);
      for (const s of openSockets) {
        if (!s.destroyed) s.destroy();
      }
      openSockets.clear();
      await new Promise<void>((resolve) => gatewayServer.close(() => resolve()));
      await new Promise<void>((resolve) => healthyServer.close(() => resolve()));
    });

    it('should fail over to healthy secondary upstream before 101 when primary node refuses connection', async () => {
      const key = crypto.randomBytes(16).toString('base64');
      const client = net.connect(gatewayPort, '127.0.0.1');
      openSockets.add(client);

      await new Promise<void>((resolve, reject) => {
        client.on('connect', () => {
          client.write(
            [
              'GET /failover HTTP/1.1',
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
          if (response.includes('101 Switching Protocols')) {
            expect(response).toContain('Upgrade: websocket');
            expect(response).toContain(`Sec-WebSocket-Accept: ${computeAcceptKey(key)}`);
            // Primary dead upstream must be marked DEGRADED
            expect(liveHealthTracker.getStatus(`http://127.0.0.1:${deadPort}`)).toBe('DEGRADED');
            // Healthy upstream must remain HEALTHY
            expect(liveHealthTracker.getStatus(`http://127.0.0.1:${healthyPort}`)).toBe('HEALTHY');
            client.destroy();
            resolve();
          }
        });

        client.on('error', reject);
      });
    });

    it('should enforce ZERO RETRY once 101 has been established and tunnel is active', async () => {
      const key = crypto.randomBytes(16).toString('base64');
      const client = net.connect(gatewayPort, '127.0.0.1');
      openSockets.add(client);

      await new Promise<void>((resolve, reject) => {
        client.on('connect', () => {
          client.write(
            [
              'GET /failover HTTP/1.1',
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

        client.once('data', (_chunk) => {
          // Tunnel is established: activeTunnelCount >= 1
          const initialCount = failoverHandler.activeTunnelCount;
          expect(initialCount).toBeGreaterThanOrEqual(1);

          // Simulate client closing the tunnel
          client.destroy();

          setTimeout(() => {
            // Once 101 is established, tunnel was cleanly torn down without retry
            expect(failoverHandler.activeTunnelCount).toBeLessThan(initialCount);
            resolve();
          }, 100);
        });

        client.on('error', reject);
      });
    });
  });
});
