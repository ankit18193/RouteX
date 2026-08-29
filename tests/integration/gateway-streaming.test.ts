import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { type FastifyInstance } from 'fastify';
import { request } from 'undici';
import { Readable } from 'node:stream';
import { createGatewayServer, type RouteXGatewayServer } from '../../src/server/gateway-server.js';
import { buildChatService } from '../../mock-services/chat-service/index.js';
import type { GatewayConfig } from '../../src/types/index.js';

describe('RouteX Zero-Buffer Streaming Reverse Proxy', () => {
  let chatService: FastifyInstance;
  let chatAddress: string;

  let gateway: RouteXGatewayServer;
  let gatewayAddress: string;

  beforeAll(async () => {
    chatService = buildChatService({ logger: false });
    chatAddress = await chatService.listen({ port: 0, host: '127.0.0.1' });

    const gatewayConfig: GatewayConfig = {
      server: {
        port: 0,
        host: '127.0.0.1',
        requestTimeoutMs: 15000,
        headersTimeoutMs: 16000,
        maxHeaderSize: 16384,
        logLevel: 'silent',
        logFormat: 'json',
        trustedProxies: ['127.0.0.1'],
      },
      redis: {
        host: '127.0.0.1',
        port: 6379,
        db: 0,
        tls: false,
        connectTimeoutMs: 1000,
      },
      routes: [
        {
          id: 'chat_stream_service',
          pathPrefix: '/stream',
          upstream: chatAddress,
          methods: ['GET', 'POST'],
          stripPrefix: true,
          auth: { mode: 'public', requiredRoles: [] },
          timeouts: { connectTimeoutMs: 2000, responseTimeoutMs: 10000 },
        },
      ],
    };

    gateway = createGatewayServer(gatewayConfig, { logger: false });
    gatewayAddress = await gateway.listen(0, '127.0.0.1');
  });

  afterAll(async () => {
    await gateway.close();
    await chatService.close();
  });

  describe('Streaming Request Forwarding (Upload)', () => {
    it('should forward multi-chunk streaming request body to upstream without buffering', async () => {
      const CHUNK_COUNT = 16;
      const CHUNK_SIZE = 64 * 1024; // 64KB * 16 = 1MB total
      const expectedTotalBytes = CHUNK_COUNT * CHUNK_SIZE;

      let chunkIndex = 0;
      const uploadStream = new Readable({
        read() {
          if (chunkIndex >= CHUNK_COUNT) {
            this.push(null);
            return;
          }
          this.push(Buffer.alloc(CHUNK_SIZE, 'Z'));
          chunkIndex += 1;
        },
      });

      const res = await request(`${gatewayAddress}/stream/api/v1/echo-stream`, {
        method: 'POST',
        headers: {
          'content-type': 'application/octet-stream',
          'x-request-id': 'req_stream_upload_1',
        },
        body: uploadStream,
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers['x-request-id']).toBe('req_stream_upload_1');

      const json = (await res.body.json()) as Record<string, unknown>;
      expect(json.status).toBe('ok');
      expect(json.service).toBe('chat-service');
      expect(json.receivedBytes).toBe(expectedTotalBytes);
      expect(json.chunkCount).toBeGreaterThanOrEqual(1);
    });
  });

  describe('Streaming Response Forwarding (Download)', () => {
    it('should stream 4MB payload from upstream through gateway with backpressure', async () => {
      const sizeMb = 4;
      const expectedBytes = sizeMb * 1024 * 1024;

      const res = await request(`${gatewayAddress}/stream/api/v1/stream-payload?sizeMb=${sizeMb}`, {
        headers: {
          'x-request-id': 'req_stream_download_4mb',
        },
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('application/octet-stream');
      expect(res.headers['content-length']).toBe(String(expectedBytes));
      expect(res.headers['x-request-id']).toBe('req_stream_download_4mb');

      let receivedBytes = 0;
      let chunkCount = 0;

      for await (const chunk of res.body) {
        receivedBytes += (chunk as Buffer).length;
        chunkCount += 1;
      }

      expect(receivedBytes).toBe(expectedBytes);
      expect(chunkCount).toBeGreaterThanOrEqual(4);
    });

    it('should handle slow consumer with backpressure without memory leaks or data loss', async () => {
      const sizeMb = 2; // 2MB
      const expectedBytes = sizeMb * 1024 * 1024;

      const res = await request(`${gatewayAddress}/stream/api/v1/stream-payload?sizeMb=${sizeMb}`, {
        headers: {
          'x-request-id': 'req_slow_consumer',
        },
      });

      expect(res.statusCode).toBe(200);

      let receivedBytes = 0;
      for await (const chunk of res.body) {
        receivedBytes += (chunk as Buffer).length;
        // Simulate slow client processing (1ms delay every chunk)
        await new Promise((r) => setTimeout(r, 1));
      }

      expect(receivedBytes).toBe(expectedBytes);
    });
  });
});
