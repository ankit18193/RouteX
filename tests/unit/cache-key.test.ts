import { describe, it, expect } from 'vitest';
import {
  generateCacheKey,
  normalizeQueryString,
  extractNormalizedVaryHeaders,
} from '../../src/cache/cache-key.js';

describe('Cache Key Generator & Normalization', () => {
  describe('normalizeQueryString', () => {
    it('should return empty string for missing or empty query', () => {
      expect(normalizeQueryString('')).toBe('');
      expect(normalizeQueryString('?')).toBe('');
      expect(normalizeQueryString(undefined)).toBe('');
    });

    it('should sort query parameters deterministically', () => {
      const q1 = normalizeQueryString('?b=2&a=1');
      const q2 = normalizeQueryString('?a=1&b=2');
      expect(q1).toBe('?a=1&b=2');
      expect(q2).toBe('?a=1&b=2');
      expect(q1).toBe(q2);
    });

    it('should sort multi-value query parameters', () => {
      const q = normalizeQueryString('?tag=b&tag=a&cat=1');
      expect(q).toBe('?cat=1&tag=a&tag=b');
    });
  });

  describe('extractNormalizedVaryHeaders', () => {
    it('should return empty string if no varyBy configured', () => {
      expect(extractNormalizedVaryHeaders({ accept: 'application/json' }, [])).toBe('');
      expect(extractNormalizedVaryHeaders({ accept: 'application/json' }, undefined)).toBe('');
    });

    it('should extract and sort configured vary headers', () => {
      const headers = {
        'Accept-Encoding': 'gzip, deflate',
        Accept: 'application/json',
        Authorization: 'Bearer secret123',
      };
      const vary = extractNormalizedVaryHeaders(headers, ['accept-encoding', 'Accept']);
      expect(vary).toBe('accept:application/json|accept-encoding:gzip, deflate');
    });

    it('should handle unset vary headers consistently', () => {
      const headers = { Accept: 'application/json' };
      const vary = extractNormalizedVaryHeaders(headers, ['accept', 'accept-encoding']);
      expect(vary).toBe('accept:application/json|accept-encoding:<unset>');
    });
  });

  describe('generateCacheKey', () => {
    it('should generate deterministic cache key for identical requests', () => {
      const key1 = generateCacheKey({
        routeId: 'route_items',
        method: 'GET',
        pathname: '/api/v1/items',
        search: '?page=1&limit=10',
        headers: { accept: 'application/json' },
        varyBy: ['accept'],
      });

      const key2 = generateCacheKey({
        routeId: 'route_items',
        method: 'GET',
        pathname: '/api/v1/items',
        search: '?limit=10&page=1',
        headers: { Accept: 'application/json' },
        varyBy: ['ACCEPT'],
      });

      expect(key1.cacheKey).toBe(key2.cacheKey);
      expect(key1.keyHash).toBe(key2.keyHash);
      expect(key1.cacheKey.startsWith('routex:cache:route_items:')).toBe(true);
    });

    it('should generate different keys for different paths', () => {
      const key1 = generateCacheKey({
        routeId: 'route_items',
        method: 'GET',
        pathname: '/api/v1/items/1',
        headers: {},
      });
      const key2 = generateCacheKey({
        routeId: 'route_items',
        method: 'GET',
        pathname: '/api/v1/items/2',
        headers: {},
      });
      expect(key1.cacheKey).not.toBe(key2.cacheKey);
    });

    it('should generate different keys for different vary headers', () => {
      const key1 = generateCacheKey({
        routeId: 'route_items',
        method: 'GET',
        pathname: '/api/v1/items',
        headers: { accept: 'application/json' },
        varyBy: ['accept'],
      });
      const key2 = generateCacheKey({
        routeId: 'route_items',
        method: 'GET',
        pathname: '/api/v1/items',
        headers: { accept: 'text/html' },
        varyBy: ['accept'],
      });
      expect(key1.cacheKey).not.toBe(key2.cacheKey);
    });

    it('should isolate authenticated cache by identity hash without leaking plaintext id', () => {
      const key1 = generateCacheKey({
        routeId: 'route_profile',
        method: 'GET',
        pathname: '/api/v1/profile',
        headers: {},
        identityId: 'user_12345',
      });
      const key2 = generateCacheKey({
        routeId: 'route_profile',
        method: 'GET',
        pathname: '/api/v1/profile',
        headers: {},
        identityId: 'user_67890',
      });

      expect(key1.cacheKey).not.toBe(key2.cacheKey);
      expect(key1.cacheKey.includes('user_12345')).toBe(false);
      expect(key2.cacheKey.includes('user_67890')).toBe(false);
    });
  });
});
