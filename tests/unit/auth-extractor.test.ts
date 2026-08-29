import { describe, it, expect } from 'vitest';
import { extractCredentials } from '../../src/auth/extractor.js';
import { UnauthorizedError } from '../../src/errors/gateway-error.js';

describe('Token Extractor', () => {
  it('should return null when no auth headers are present', () => {
    const result = extractCredentials({});
    expect(result).toBeNull();
  });

  it('should extract JWT from Authorization: Bearer <jwt>', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1c3JfMTIzIn0.xyz';
    const result = extractCredentials({
      authorization: `Bearer ${jwt}`,
    });

    expect(result).not.toBeNull();
    expect(result?.type).toBe('jwt');
    expect(result?.source).toBe('authorization-bearer');
    expect(result?.rawToken).toBe(jwt);
  });

  it('should extract API key from Authorization: Bearer rx_live_...', () => {
    const apiKey = 'rx_live_12345678901234567890123456789012';
    const result = extractCredentials({
      authorization: `Bearer ${apiKey}`,
    });

    expect(result).not.toBeNull();
    expect(result?.type).toBe('api-key');
    expect(result?.source).toBe('authorization-bearer');
    expect(result?.rawToken).toBe(apiKey);
  });

  it('should extract API key from X-API-Key header', () => {
    const apiKey = 'rx_live_12345678901234567890123456789012';
    const result = extractCredentials({
      'x-api-key': apiKey,
    });

    expect(result).not.toBeNull();
    expect(result?.type).toBe('api-key');
    expect(result?.source).toBe('x-api-key');
    expect(result?.rawToken).toBe(apiKey);
  });

  it('should enforce deterministic precedence: X-API-Key takes precedence when both are provided', () => {
    const apiKey = 'rx_live_api_key_primary';
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c3Jfand0In0.sig';

    const result = extractCredentials({
      'x-api-key': apiKey,
      'authorization': `Bearer ${jwt}`,
    });

    expect(result).not.toBeNull();
    expect(result?.type).toBe('api-key');
    expect(result?.source).toBe('x-api-key');
    expect(result?.rawToken).toBe(apiKey);
  });

  it('should handle case-insensitive header names', () => {
    const apiKey = 'rx_live_case_test';
    const result = extractCredentials({
      'X-Api-Key': apiKey,
    });

    expect(result).not.toBeNull();
    expect(result?.rawToken).toBe(apiKey);
  });

  it('should throw UnauthorizedError on malformed Authorization scheme (e.g. Basic)', () => {
    expect(() =>
      extractCredentials({
        authorization: 'Basic dXNlcjpwYXNz',
      })
    ).toThrow(UnauthorizedError);
  });

  it('should throw UnauthorizedError on empty Bearer token', () => {
    expect(() =>
      extractCredentials({
        authorization: 'Bearer ',
      })
    ).toThrow(UnauthorizedError);

    expect(() =>
      extractCredentials({
        authorization: 'Bearer',
      })
    ).toThrow(UnauthorizedError);
  });

  it('should throw UnauthorizedError on Authorization header with multiple space-separated tokens', () => {
    expect(() =>
      extractCredentials({
        authorization: 'Bearer token1 token2',
      })
    ).toThrow(UnauthorizedError);
  });

  it('should throw UnauthorizedError on empty X-API-Key header', () => {
    expect(() =>
      extractCredentials({
        'x-api-key': '   ',
      })
    ).toThrow(UnauthorizedError);
  });

  it('should throw UnauthorizedError on X-API-Key with newline/CRLF characters', () => {
    expect(() =>
      extractCredentials({
        'x-api-key': 'rx_live_key\r\nInjected-Header: value',
      })
    ).toThrow(UnauthorizedError);
  });
});
