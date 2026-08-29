import { createHash } from 'node:crypto';
import type { RateLimitNamespace, RateLimitRequest } from './types.js';

/**
 * Deterministically hash sensitive credential identifiers (like raw API keys).
 */
export function hashRateLimitIdentifier(raw: string): string {
  return createHash('sha256').update(raw).digest('hex').slice(0, 32);
}

/**
 * Normalize rate limit identifier according to namespace.
 */
export function normalizeIdentifier(namespace: RateLimitNamespace, identifier: string): string {
  const trimmed = identifier.trim();
  if (trimmed.length === 0) {
    throw new Error(`Rate limit identifier cannot be empty for namespace '${namespace}'`);
  }

  // If raw API key format is passed in, hash it immediately so raw secrets never touch Redis
  if (namespace === 'key' && trimmed.startsWith('rx_live_')) {
    return hashRateLimitIdentifier(trimmed);
  }

  // Sanitize characters that could collide with Redis key delimiters
  return trimmed.replace(/[\r\n\t]/g, '');
}

/**
 * Generate Redis key for rate limiting.
 * Format: [keyPrefix]rl:{namespace}:{identifier}:{routeId}:{windowSec}
 */
export function generateRateLimitKey(
  request: Pick<RateLimitRequest, 'namespace' | 'identifier' | 'routeId' | 'windowSec'>,
  keyPrefix = ''
): string {
  const { namespace, identifier, routeId, windowSec } = request;

  if (windowSec <= 0) {
    throw new Error(`Rate limit windowSec must be strictly greater than 0, received: ${windowSec}`);
  }

  const cleanIdentifier = normalizeIdentifier(namespace, identifier);
  const cleanRouteId = routeId.trim().replace(/[:\s]/g, '_');
  const baseKey = `rl:${namespace}:${cleanIdentifier}:${cleanRouteId}:${windowSec}`;

  return keyPrefix ? `${keyPrefix}${baseKey}` : baseKey;
}
