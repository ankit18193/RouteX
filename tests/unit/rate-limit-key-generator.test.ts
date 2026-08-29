import { describe, it, expect } from 'vitest';
import {
  generateRateLimitKey,
  hashRateLimitIdentifier,
} from '../../src/rate-limit/key-generator.js';

describe('Rate Limit Key Generator', () => {
  it('should generate standard IP namespace key', () => {
    const key = generateRateLimitKey({
      namespace: 'ip',
      identifier: '192.168.1.10',
      routeId: 'user_service_api',
      windowSec: 60,
    });

    expect(key).toBe('rl:ip:192.168.1.10:user_service_api:60');
  });

  it('should generate standard user namespace key', () => {
    const key = generateRateLimitKey({
      namespace: 'user',
      identifier: 'usr_12345',
      routeId: 'chat_messages',
      windowSec: 30,
    });

    expect(key).toBe('rl:user:usr_12345:chat_messages:30');
  });

  it('should hash raw API key in key namespace so raw secret is never in Redis', () => {
    const rawKey = 'rx_live_abcdef12345678901234567890123456';
    const expectedHash = hashRateLimitIdentifier(rawKey);

    const key = generateRateLimitKey({
      namespace: 'key',
      identifier: rawKey,
      routeId: 'api_v1',
      windowSec: 60,
    });

    expect(key).toBe(`rl:key:${expectedHash}:api_v1:60`);
    expect(key).not.toContain('rx_live_');
  });

  it('should apply global key prefix when provided', () => {
    const key = generateRateLimitKey(
      {
        namespace: 'ip',
        identifier: '10.0.0.1',
        routeId: 'health_check',
        windowSec: 10,
      },
      'routex:'
    );

    expect(key).toBe('routex:rl:ip:10.0.0.1:health_check:10');
  });

  it('should throw error when identifier is empty or whitespace', () => {
    expect(() =>
      generateRateLimitKey({
        namespace: 'ip',
        identifier: '   ',
        routeId: 'test_route',
        windowSec: 60,
      })
    ).toThrow('Rate limit identifier cannot be empty');
  });

  it('should throw error when windowSec <= 0', () => {
    expect(() =>
      generateRateLimitKey({
        namespace: 'user',
        identifier: 'usr_1',
        routeId: 'test_route',
        windowSec: 0,
      })
    ).toThrow('windowSec must be strictly greater than 0');
  });

  it('should sanitize routeId containing colons or spaces', () => {
    const key = generateRateLimitKey({
      namespace: 'ip',
      identifier: '127.0.0.1',
      routeId: 'users:me custom route',
      windowSec: 60,
    });

    expect(key).toBe('rl:ip:127.0.0.1:users_me_custom_route:60');
  });
});
