import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { type FastifyInstance } from 'fastify';
import { request } from 'undici';
import { buildUserService } from '../../mock-services/user-service/index.js';
import { buildChatService } from '../../mock-services/chat-service/index.js';

describe('Live Mock Services Integration', () => {
  let userApp: FastifyInstance;
  let chatApp: FastifyInstance;
  let userAddress: string;
  let chatAddress: string;

  beforeAll(async () => {
    userApp = buildUserService({ logger: false });
    chatApp = buildChatService({ logger: false });

    userAddress = await userApp.listen({ port: 0, host: '127.0.0.1' });
    chatAddress = await chatApp.listen({ port: 0, host: '127.0.0.1' });
  });

  afterAll(async () => {
    await userApp.close();
    await chatApp.close();
  });

  it('should verify live User Service healthz over real HTTP port', async () => {
    const res = await request(`${userAddress}/healthz`);
    expect(res.statusCode).toBe(200);
    const body = (await res.body.json()) as Record<string, unknown>;
    expect(body.status).toBe('ok');
    expect(body.service).toBe('user-service');
  });

  it('should verify live Chat Service healthz over real HTTP port', async () => {
    const res = await request(`${chatAddress}/healthz`);
    expect(res.statusCode).toBe(200);
    const body = (await res.body.json()) as Record<string, unknown>;
    expect(body.status).toBe('ok');
    expect(body.service).toBe('chat-service');
  });

  it('should verify abrupt socket crash on GET /api/v1/users/fault?type=crash', async () => {
    await expect(async () => {
      await request(`${userAddress}/api/v1/users/fault?type=crash`, {
        headersTimeout: 1000,
        bodyTimeout: 1000,
      });
    }).rejects.toThrow();
  });

  it('should stream 1MB from live Chat Service without buffer accumulation', async () => {
    const res = await request(`${chatAddress}/api/v1/stream-payload?sizeMb=1`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/octet-stream');

    let totalBytes = 0;
    for await (const chunk of res.body) {
      totalBytes += (chunk as Buffer).length;
    }
    expect(totalBytes).toBe(1024 * 1024);
  });
});
