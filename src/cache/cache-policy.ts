import type { RouteDefinition, RouteCachePolicy } from '../types/index.js';
import type { AuthContext } from '../auth/types.js';

export interface RequestCacheabilityResult {
  readonly cacheable: boolean;
  readonly reason?: string | undefined;
}

export interface ResponseCacheabilityResult {
  readonly cacheable: boolean;
  readonly ttlSec: number;
  readonly reason?: string | undefined;
}

/**
 * Hop-by-hop and private headers that must never be cached or served from cache.
 */
const UNCACHEABLE_HEADERS = new Set([
  'set-cookie',
  'authorization',
  'proxy-authenticate',
  'proxy-authorization',
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'te',
  'trailer',
  'content-length', // Recalculated on response emission
]);

/**
 * Determines whether an incoming request is eligible for response cache lookup.
 */
export function isRequestCacheable(
  route: RouteDefinition,
  method: string,
  headers: Record<string, string | string[] | undefined>,
  authContext?: AuthContext
): RequestCacheabilityResult {
  // 1. Check if cache policy is configured and enabled
  if (!route.cache || !route.cache.enabled) {
    return { cacheable: false, reason: 'CACHE_DISABLED' };
  }

  // 2. Only safe GET requests are cacheable
  if (method.toUpperCase() !== 'GET') {
    return { cacheable: false, reason: 'METHOD_NOT_CACHEABLE' };
  }

  // 3. Check authentication constraints
  if (authContext && authContext.authenticated && !route.cache.allowAuthenticated) {
    return { cacheable: false, reason: 'AUTHENTICATED_REQUEST_NOT_PERMITTED' };
  }

  // 4. Client Cache-Control: no-store / pragma: no-cache
  if (route.cache.respectCacheControl) {
    const rawCacheControl = headers['cache-control'];
    const cc = typeof rawCacheControl === 'string' ? rawCacheControl.toLowerCase() : '';
    if (cc.includes('no-store')) {
      return { cacheable: false, reason: 'CLIENT_NO_STORE' };
    }
  }

  return { cacheable: true };
}

/**
 * Determines whether an upstream response is eligible for caching in Redis.
 */
export function isResponseCacheable(
  statusCode: number,
  headers: Record<string, string | string[] | undefined>,
  bodyLengthBytes: number,
  policy: RouteCachePolicy
): ResponseCacheabilityResult {
  // 1. Only 200 OK responses are cacheable (never 4xx or 5xx)
  if (statusCode !== 200) {
    return { cacheable: false, ttlSec: 0, reason: 'STATUS_NOT_CACHEABLE' };
  }

  // 2. Enforce strict maxBodyBytes safety
  if (bodyLengthBytes > policy.maxBodyBytes) {
    return { cacheable: false, ttlSec: 0, reason: 'RESPONSE_BODY_EXCEEDS_MAX_BYTES' };
  }

  let effectiveTtlSec = policy.ttlSec;

  // 3. Respect upstream Cache-Control directives
  if (policy.respectCacheControl) {
    const rawCacheControl = headers['cache-control'];
    if (typeof rawCacheControl === 'string') {
      const cc = rawCacheControl.toLowerCase();

      // Upstream explicitly forbids storing response
      if (cc.includes('no-store')) {
        return { cacheable: false, ttlSec: 0, reason: 'UPSTREAM_NO_STORE' };
      }

      // Upstream marks response as private (unless route explicitly allows authenticated cache)
      if (cc.includes('private') && !policy.allowAuthenticated) {
        return { cacheable: false, ttlSec: 0, reason: 'UPSTREAM_PRIVATE' };
      }

      // Parse max-age directive (e.g. "max-age=60")
      const maxAgeMatch = cc.match(/max-age=(\d+)/);
      if (maxAgeMatch && maxAgeMatch[1]) {
        const parsedMaxAge = parseInt(maxAgeMatch[1], 10);
        if (parsedMaxAge === 0) {
          return { cacheable: false, ttlSec: 0, reason: 'UPSTREAM_MAX_AGE_ZERO' };
        }
        if (parsedMaxAge > 0) {
          effectiveTtlSec = parsedMaxAge;
        }
      }
    }
  }

  return {
    cacheable: true,
    ttlSec: effectiveTtlSec,
  };
}

/**
 * Sanitizes headers before storing them in cache entry.
 */
export function sanitizeCacheHeaders(
  headers: Record<string, string | string[] | undefined>
): Record<string, string> {
  const sanitized: Record<string, string> = {};

  for (const [key, val] of Object.entries(headers)) {
    if (val === undefined || val === null) {
      continue;
    }
    const lowerKey = key.toLowerCase();
    if (UNCACHEABLE_HEADERS.has(lowerKey)) {
      continue;
    }
    sanitized[lowerKey] = Array.isArray(val) ? val.join(', ') : String(val);
  }

  return sanitized;
}
