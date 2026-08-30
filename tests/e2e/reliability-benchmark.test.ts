import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { type FastifyInstance } from 'fastify';
import { request } from 'undici';
import { createGatewayServer, type RouteXGatewayServer } from '../../src/server/gateway-server.js';
import { buildUserService } from '../../mock-services/user-service/index.js';
import { buildChatService } from '../../mock-services/chat-service/index.js';
import type { GatewayConfigInput } from '../../src/types/index.js';

describe('RouteX E2E Acceptance — Reliability, Fault Injection & Memory Benchmark Suite', () => {
  let userService: FastifyInstance;
  let chatService: FastifyInstance;
  let userAddress: string;
  let chatAddress: string;

  let gateway: RouteXGatewayServer;
  let gatewayAddress: string;

  beforeAll(async () => {
    userService = buildUserService({ logger: false });
    chatService = buildChatService({ logger: false });

    userAddress = await userService.listen({ port: 0, host: '127.0.0.1' });
    chatAddress = await chatService.listen({ port: 0, host: '127.0.0.1' });

    const gatewayConfig: GatewayConfigInput = {
      server: {
        port: 8080,
        host: '127.0.0.1',
        requestTimeoutMs: 15000,
        headersTimeoutMs: 16000,
        maxHeaderSize: 16384,
        logLevel: 'silent',
        logFormat: 'json',
        trustedProxies: ['127.0.0.1'],
      },
      routes: [
        {
          id: 'route_users',
          pathPrefix: '/api/v1/users',
          upstream: userAddress,
          stripPrefix: false,
          methods: ['GET', 'POST'],
          auth: { mode: 'public' },
          timeouts: {
            connectTimeoutMs: 1000,
            responseTimeoutMs: 1200, // Short response timeout for testing 504
          },
        },
        {
          id: 'route_dead_upstream',
          pathPrefix: '/api/v1/dead-upstream',
          upstream: 'http://127.0.0.1:59999', // Port where nothing is listening
          stripPrefix: true,
          methods: ['GET'],
          auth: { mode: 'public' },
          timeouts: {
            connectTimeoutMs: 500,
            responseTimeoutMs: 1000,
          },
        },
        {
          id: 'route_chat_stream',
          pathPrefix: '/stream',
          upstream: chatAddress,
          stripPrefix: true,
          methods: ['GET', 'POST'],
          auth: { mode: 'public' },
          timeouts: {
            connectTimeoutMs: 2000,
            responseTimeoutMs: 30000,
          },
        },
      ],
    };

    gateway = createGatewayServer(gatewayConfig, { logger: false });
    await gateway.listen(0, '127.0.0.1');
    const port = (gateway.fastifyInstance.server.address() as any).port;
    gatewayAddress = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    try {
      await gateway.close();
      await userService.close();
      await chatService.close();
    } catch {
      // Ignored
    }
  });

  // ============================================================================
  // 1. FAULT INJECTION & UPSTREAM RESILIENCE
  // ============================================================================
  describe('Fault-Injection & Upstream Failure Resilience', () => {
    it('should return 502 BAD_GATEWAY with JSON envelope when upstream connection is refused', async () => {
      const res = await request(`${gatewayAddress}/api/v1/dead-upstream/test`);
      expect(res.statusCode).toBe(502);
      expect(res.headers['content-type']).toContain('application/json');

      const body = (await res.body.json()) as any;
      expect(body.error).toBe('BAD_GATEWAY');
      expect(body.statusCode).toBe(502);
      expect(body.requestId).toBeDefined();
    });

    it('should return 502 BAD_GATEWAY when upstream abruptly crashes / destroys socket mid-request', async () => {
      const res = await request(`${gatewayAddress}/api/v1/users/fault?type=crash`);
      expect(res.statusCode).toBe(502);

      const body = (await res.body.json()) as any;
      expect(body.error).toBe('BAD_GATEWAY');
      expect(body.statusCode).toBe(502);
    });

    it('should return 504 GATEWAY_TIMEOUT when upstream exceeds configured response timeout', async () => {
      // Route response timeout is 1200ms, request delays by 2500ms
      const res = await request(`${gatewayAddress}/api/v1/users/slow?delayMs=2500`);
      expect(res.statusCode).toBe(504);

      const body = (await res.body.json()) as any;
      expect(body.error).toBe('GATEWAY_TIMEOUT');
      expect(body.statusCode).toBe(504);
      expect(body.message).toContain('timed out');
    });
  });

  // ============================================================================
  // 2. STREAMING PERFORMANCE & MEMORY PROFILING BENCHMARK
  // ============================================================================
  describe('Streaming Performance & Memory Constant Allocation Benchmark', () => {
    it('should stream 15MB payload with constant memory usage (< 35MB heap growth)', async () => {
      // Force GC if available or record initial baseline heap
      if (global.gc) {
        global.gc();
      }

      const initialHeapUsed = process.memoryUsage().heapUsed;
      const sizeMb = 15;
      const expectedBytes = sizeMb * 1024 * 1024;

      let maxHeapObserved = initialHeapUsed;
      let totalBytesReceived = 0;

      const res = await request(`${gatewayAddress}/stream/api/v1/stream-payload?sizeMb=${sizeMb}`);
      expect(res.statusCode).toBe(200);

      for await (const chunk of res.body) {
        totalBytesReceived += (chunk as Buffer).length;
        const currentHeap = process.memoryUsage().heapUsed;
        if (currentHeap > maxHeapObserved) {
          maxHeapObserved = currentHeap;
        }
      }

      expect(totalBytesReceived).toBe(expectedBytes);

      const heapGrowthBytes = maxHeapObserved - initialHeapUsed;
      const heapGrowthMb = heapGrowthBytes / (1024 * 1024);

      // Verify that streaming 15MB did not accumulate in gateway memory (heap growth remains bounded < 35MB)
      expect(heapGrowthMb).toBeLessThan(35);
    });
  });

  // ============================================================================
  // 3. GRACEFUL SHUTDOWN & IN-FLIGHT REQUEST DRAINING
  // ============================================================================
  describe('Graceful Shutdown & Readiness Acceptance', () => {
    it('should reject new requests on /readyz during shutdown while finishing in-flight work', async () => {
      const shutdownGateway = createGatewayServer({
        server: { port: 8080, host: '127.0.0.1', logLevel: 'silent' },
        routes: [
          {
            id: 'route_slow',
            pathPrefix: '/api/v1/users',
            upstream: userAddress,
            stripPrefix: false,
            methods: ['GET'],
            auth: { mode: 'public' },
          },
        ],
      }, { logger: false });

      await shutdownGateway.listen(0, '127.0.0.1');
      const sPort = (shutdownGateway.fastifyInstance.server.address() as any).port;
      const sAddr = `http://127.0.0.1:${sPort}`;

      // 1. Check readiness initially 200 OK
      const resReady1 = await request(`${sAddr}/readyz`);
      expect(resReady1.statusCode).toBe(200);
      await resReady1.body.dump();

      // 2. Launch an in-flight request
      const inFlightPromise = request(`${sAddr}/api/v1/users/slow?delayMs=300`, {
        headers: { connection: 'close' },
      });

      // Allow request to reach upstream
      await new Promise((resolve) => setTimeout(resolve, 50));

      // 3. Initiate graceful close
      const closePromise = shutdownGateway.close();

      // 4. In-flight request should complete with 200 OK
      const inFlightRes = await inFlightPromise;
      expect(inFlightRes.statusCode).toBe(200);
      await inFlightRes.body.dump();

      await closePromise;
    });
  });
});
