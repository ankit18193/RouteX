import { describe, it, expect } from 'vitest';
import {
  getHopByHopHeaders,
  sanitizeRequestHeaders,
  sanitizeResponseHeaders,
} from '../../src/proxy/headers.js';

describe('Proxy Header Sanitization (RFC 7230 / RFC 9110)', () => {
  describe('getHopByHopHeaders', () => {
    it('should include standard hop-by-hop headers by default', () => {
      const hopByHop = getHopByHopHeaders({});
      expect(hopByHop.has('connection')).toBe(true);
      expect(hopByHop.has('keep-alive')).toBe(true);
      expect(hopByHop.has('transfer-encoding')).toBe(true);
      expect(hopByHop.has('upgrade')).toBe(true);
      expect(hopByHop.has('proxy-authorization')).toBe(true);
    });

    it('should dynamically parse Connection-token nominated headers', () => {
      const hopByHop = getHopByHopHeaders({
        connection: 'close, X-Custom-Hop, X-Foo-Bar',
      });
      expect(hopByHop.has('connection')).toBe(true);
      expect(hopByHop.has('close')).toBe(true);
      expect(hopByHop.has('x-custom-hop')).toBe(true);
      expect(hopByHop.has('x-foo-bar')).toBe(true);
    });

    it('should handle array Connection header', () => {
      const hopByHop = getHopByHopHeaders({
        connection: ['keep-alive', 'X-Token-1, X-Token-2'] as any,
      });
      expect(hopByHop.has('x-token-1')).toBe(true);
      expect(hopByHop.has('x-token-2')).toBe(true);
    });
  });

  describe('sanitizeRequestHeaders', () => {
    it('should strip standard and dynamic hop-by-hop headers', () => {
      const sanitized = sanitizeRequestHeaders(
        {
          'connection': 'close, X-Transient-Header',
          'keep-alive': 'timeout=5',
          'upgrade': 'websocket',
          'x-transient-header': 'secret-token',
          'accept': 'application/json',
          'user-agent': 'RouteXClient/1.0',
        },
        {
          clientIp: '192.168.1.50',
          requestId: 'req_12345',
          targetHost: 'api.internal:4001',
          originalHost: 'gateway.example.com',
          proto: 'https',
        }
      );

      expect(sanitized['connection']).toBeUndefined();
      expect(sanitized['keep-alive']).toBeUndefined();
      expect(sanitized['upgrade']).toBeUndefined();
      expect(sanitized['x-transient-header']).toBeUndefined();

      expect(sanitized['accept']).toBe('application/json');
      expect(sanitized['user-agent']).toBe('RouteXClient/1.0');
      expect(sanitized['host']).toBe('api.internal:4001');
      expect(sanitized['x-request-id']).toBe('req_12345');
      expect(sanitized['x-forwarded-for']).toBe('192.168.1.50');
      expect(sanitized['x-forwarded-proto']).toBe('https');
      expect(sanitized['x-forwarded-host']).toBe('gateway.example.com');
      expect(sanitized['x-gateway-forwarded-by']).toBe('routex');
    });

    it('should strip untrusted spoofed identity and gateway headers from client', () => {
      const sanitized = sanitizeRequestHeaders(
        {
          'x-user-id': 'usr_spoofed_admin',
          'x-user-roles': 'superadmin',
          'x-auth-type': 'spoofed',
          'x-gateway-auth-status': 'spoofed',
          'x-gateway-internal': 'true',
          'authorization': 'Bearer some-token',
        },
        {
          clientIp: '10.0.0.1',
          requestId: 'req_safe',
          targetHost: 'users.service',
        }
      );

      expect(sanitized['x-user-id']).toBeUndefined();
      expect(sanitized['x-user-roles']).toBeUndefined();
      expect(sanitized['x-auth-type']).toBeUndefined();
      expect(sanitized['x-gateway-auth-status']).toBeUndefined();
      expect(sanitized['x-gateway-internal']).toBeUndefined();
      expect(sanitized['authorization']).toBe('Bearer some-token');
    });

    it('should append client IP to existing X-Forwarded-For chain', () => {
      const sanitized = sanitizeRequestHeaders(
        {
          'x-forwarded-for': '203.0.113.195, 70.41.3.18',
        },
        {
          clientIp: '10.0.0.99',
          requestId: 'req_chain',
          targetHost: 'service.local',
        }
      );

      expect(sanitized['x-forwarded-for']).toBe('203.0.113.195, 70.41.3.18, 10.0.0.99');
    });
  });

  describe('sanitizeResponseHeaders', () => {
    it('should strip upstream hop-by-hop headers and preserve safe response headers', () => {
      const sanitized = sanitizeResponseHeaders(
        {
          'connection': 'close',
          'transfer-encoding': 'chunked',
          'content-type': 'application/json; charset=utf-8',
          'content-length': 42,
          'cache-control': 'public, max-age=3600',
          'set-cookie': ['session=abc123; HttpOnly; Secure'],
          'x-upstream-version': '2.1.0',
        },
        'req_resp_test'
      );

      expect(sanitized['connection']).toBeUndefined();
      expect(sanitized['transfer-encoding']).toBeUndefined();
      expect(sanitized['content-type']).toBe('application/json; charset=utf-8');
      expect(sanitized['content-length']).toBe('42');
      expect(sanitized['cache-control']).toBe('public, max-age=3600');
      expect(sanitized['set-cookie']).toEqual(['session=abc123; HttpOnly; Secure']);
      expect(sanitized['x-upstream-version']).toBe('2.1.0');
      expect(sanitized['x-request-id']).toBe('req_resp_test');
    });
  });
});
