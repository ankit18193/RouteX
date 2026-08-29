import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { RedisClient, createRedisClient } from '../../src/rate-limit/redis-client.js';
import {
  SLIDING_WINDOW_LUA_SCRIPT,
  SLIDING_WINDOW_LUA_SHA,
  decodeLuaResult,
} from '../../src/rate-limit/lua-scripts.js';

describe('RedisClient Foundation & Lua Management', () => {
  let client: RedisClient;

  beforeAll(async () => {
    client = createRedisClient({
      host: '127.0.0.1',
      port: 6379,
      connectTimeoutMs: 2000,
    });
    await client.connect();
  });

  afterAll(async () => {
    await client.close();
  });

  it('should report ready status when connected', () => {
    expect(client.isReady()).toBe(true);
    expect(client.status).toBe('ready');
  });

  it('should respond to PING with PONG', async () => {
    const pong = await client.ping();
    expect(pong).toBe('PONG');
  });

  it('should load Lua script and return matching SHA1 digest', async () => {
    const sha = await client.loadScript(SLIDING_WINDOW_LUA_SCRIPT);
    expect(sha).toBe(SLIDING_WINDOW_LUA_SHA);
  });

  it('should execute EVALSHA with loaded Lua script', async () => {
    const key = 'test:rl:unit_foundation_01';
    const now = Date.now();
    const rawResult = await client.evalSha(
      SLIDING_WINDOW_LUA_SHA,
      [key],
      [60000, 10, now, 'req_init_01']
    );

    const decoded = decodeLuaResult(rawResult);
    expect(decoded.allowed).toBe(true);
    expect(decoded.limit).toBe(10);
    expect(decoded.remaining).toBe(9);
    expect(decoded.resetAt).toBeGreaterThan(0);
    expect(decoded.retryAfterSec).toBe(0);

    // Clean up test key
    await client.rawClient.del(key);
  });

  it('should decode Lua result tuple correctly', () => {
    const allowedTuple = [1, 4, 1724900000, 5, 0];
    const decodedAllowed = decodeLuaResult(allowedTuple);
    expect(decodedAllowed.allowed).toBe(true);
    expect(decodedAllowed.remaining).toBe(4);
    expect(decodedAllowed.resetAt).toBe(1724900000);
    expect(decodedAllowed.limit).toBe(5);
    expect(decodedAllowed.retryAfterSec).toBe(0);

    const rejectedTuple = [0, 0, 1724900000, 5, 12];
    const decodedRejected = decodeLuaResult(rejectedTuple);
    expect(decodedRejected.allowed).toBe(false);
    expect(decodedRejected.remaining).toBe(0);
    expect(decodedRejected.limit).toBe(5);
    expect(decodedRejected.retryAfterSec).toBe(12);
  });

  it('should throw on invalid Lua result structure', () => {
    expect(() => decodeLuaResult('invalid')).toThrow('Invalid Redis Lua rate limit response structure');
    expect(() => decodeLuaResult([1, 2])).toThrow('Invalid Redis Lua rate limit response structure');
  });
});
