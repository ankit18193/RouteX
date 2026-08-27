import { describe, it, expect } from 'vitest';
import {
  generateRequestId,
  isValidRequestId,
  normalizeRequestId,
  sanitizeHeaderValue,
} from '../../src/utils/uuid.js';
import * as UtilsModule from '../../src/utils/index.js';

describe('UUID and Request ID Utilities', () => {
  it('should export all utils symbols from index.ts', () => {
    expect(UtilsModule.generateRequestId).toBeDefined();
    expect(UtilsModule.isValidRequestId).toBeDefined();
    expect(UtilsModule.startTimer).toBeDefined();
  });

  it('should generate valid Request IDs starting with req_', () => {
    const reqId = generateRequestId();
    expect(reqId.startsWith('req_')).toBe(true);
    expect(isValidRequestId(reqId)).toBe(true);
    expect(reqId.length).toBeGreaterThan(30);
  });

  it('should validate acceptable request ID formats', () => {
    expect(isValidRequestId('req_550e8400-e29b-41d4-a716-446655440000')).toBe(true);
    expect(isValidRequestId('trace-123.456:abc')).toBe(true);
    expect(isValidRequestId('')).toBe(false);
    expect(isValidRequestId('req with spaces')).toBe(false);
    expect(isValidRequestId('req\r\ninjection')).toBe(false);
    expect(isValidRequestId('a'.repeat(200))).toBe(false);
  });

  it('should normalize incoming request IDs safely', () => {
    expect(normalizeRequestId('custom-request-123')).toBe('custom-request-123');
    expect(normalizeRequestId(['valid-array-req-id'])).toBe('valid-array-req-id');

    // Empty array or empty string array should trigger fallback generation
    const emptyArrayFallback = normalizeRequestId([]);
    expect(emptyArrayFallback.startsWith('req_')).toBe(true);

    const emptyElementFallback = normalizeRequestId(['']);
    expect(emptyElementFallback.startsWith('req_')).toBe(true);

    // Invalid format should trigger fallback generation
    const fallback = normalizeRequestId('invalid req id with spaces');
    expect(fallback.startsWith('req_')).toBe(true);

    const emptyFallback = normalizeRequestId(undefined);
    expect(emptyFallback.startsWith('req_')).toBe(true);
  });

  it('should sanitize string against CRLF header injection', () => {
    expect(sanitizeHeaderValue('admin\r\nSet-Cookie: evil=true')).toBe('adminSet-Cookie: evil=true');
    expect(sanitizeHeaderValue('user\0evil')).toBe('userevil');
    expect(sanitizeHeaderValue('  clean-user-id  ')).toBe('clean-user-id');
    expect(sanitizeHeaderValue(undefined as any)).toBe('');
  });
});
