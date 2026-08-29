import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { type FastifyInstance } from 'fastify';
import { Readable } from 'node:stream';
import { buildChatService } from '../../mock-services/chat-service/index.js';

describe('Mock Chat Service', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = buildChatService({ logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('GET /healthz', () => {
    it('should return 200 with chat service health status', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/healthz',
      });

      expect(response.statusCode).toBe(200);
      const json = response.json();
      expect(json.status).toBe('ok');
      expect(json.service).toBe('chat-service');
      expect(typeof json.timestamp).toBe('string');
    });
  });

  describe('GET /api/v1/chats', () => {
    it('should return mock chat list', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/chats',
      });

      expect(response.statusCode).toBe(200);
      const json = response.json();
      expect(json.service).toBe('chat-service');
      expect(Array.isArray(json.chats)).toBe(true);
      expect(json.chats.length).toBeGreaterThan(0);
      expect(json.chats[0]).toHaveProperty('id');
      expect(json.chats[0]).toHaveProperty('name');
    });
  });

  describe('POST /api/v1/messages', () => {
    it('should create message with 201 when payload is valid', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/messages',
        headers: {
          'x-user-id': 'usr_bob_777',
        },
        payload: {
          chatId: 'chat_gen_01',
          content: 'Hello, RouteX API Gateway!',
        },
      });

      expect(response.statusCode).toBe(201);
      const json = response.json();
      expect(json.chatId).toBe('chat_gen_01');
      expect(json.content).toBe('Hello, RouteX API Gateway!');
      expect(json.senderId).toBe('usr_bob_777');
      expect(json.id.startsWith('msg_')).toBe(true);
      expect(typeof json.createdAt).toBe('string');
    });

    it('should default senderId to usr_anonymous when x-user-id header is missing', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/messages',
        payload: {
          chatId: 'chat_gen_01',
          content: 'Anonymous message',
        },
      });

      expect(response.statusCode).toBe(201);
      const json = response.json();
      expect(json.senderId).toBe('usr_anonymous');
    });

    it('should reject missing chatId or content with 400', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/messages',
        payload: {
          chatId: 'chat_1',
          // missing content
        },
      });

      expect(response.statusCode).toBe(400);
      const json = response.json();
      expect(json.error).toBe('BAD_REQUEST');
      expect(json.message).toContain('chatId and content must be non-empty strings');
    });

    it('should reject invalid JSON body with 400', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/messages',
        headers: {
          'content-type': 'application/json',
        },
        body: 'invalid-json-string{',
      });

      expect(response.statusCode).toBe(400);
      const json = response.json();
      expect(json.error).toBe('BAD_REQUEST');
    });
  });

  describe('POST /api/v1/echo-stream (Streaming Upload)', () => {
    it('should consume request stream without buffering and count bytes accurately', async () => {
      const CHUNK_COUNT = 8;
      const CHUNK_SIZE = 16 * 1024; // 16KB per chunk = 128KB total
      const expectedTotalBytes = CHUNK_COUNT * CHUNK_SIZE;

      let chunkIndex = 0;
      const uploadStream = new Readable({
        read() {
          if (chunkIndex >= CHUNK_COUNT) {
            this.push(null);
            return;
          }
          this.push(Buffer.alloc(CHUNK_SIZE, 'A'));
          chunkIndex += 1;
        },
      });

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/echo-stream',
        headers: {
          'content-type': 'application/octet-stream',
        },
        body: uploadStream,
      });

      expect(response.statusCode).toBe(200);
      const json = response.json();
      expect(json.status).toBe('ok');
      expect(json.service).toBe('chat-service');
      expect(json.receivedBytes).toBe(expectedTotalBytes);
      expect(json.chunkCount).toBeGreaterThanOrEqual(1);
    });
  });

  describe('GET /api/v1/stream-payload (Streaming Download)', () => {
    it('should stream requested sizeMb in chunks without buffer accumulation', async () => {
      const sizeMb = 2; // 2MB
      const expectedBytes = sizeMb * 1024 * 1024;

      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/stream-payload?sizeMb=${sizeMb}`,
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toBe('application/octet-stream');
      expect(response.headers['content-length']).toBe(String(expectedBytes));
      expect(response.rawPayload.length).toBe(expectedBytes);
    });

    it('should default to 1MB stream if sizeMb is not provided', async () => {
      const expectedBytes = 1 * 1024 * 1024;

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/stream-payload',
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-length']).toBe(String(expectedBytes));
      expect(response.rawPayload.length).toBe(expectedBytes);
    });

    it('should reject sizeMb <= 0 with 400', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/stream-payload?sizeMb=0',
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error).toBe('BAD_REQUEST');
    });

    it('should reject sizeMb > 500 with 400', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/stream-payload?sizeMb=501',
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error).toBe('BAD_REQUEST');
    });

    it('should reject non-numeric sizeMb with 400', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/stream-payload?sizeMb=invalid',
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error).toBe('BAD_REQUEST');
    });
  });
});
