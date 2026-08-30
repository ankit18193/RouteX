import { createHash } from 'node:crypto';
import type { GenerateCacheKeyOptions, GeneratedCacheKey } from './types.js';

/**
 * Normalizes query string by sorting query parameters deterministically.
 */
export function normalizeQueryString(search?: string): string {
  if (!search || search === '?' || search.trim() === '') {
    return '';
  }

  const raw = search.startsWith('?') ? search.slice(1) : search;
  const params = new URLSearchParams(raw);
  const sortedKeys = Array.from(new Set(params.keys())).sort();

  const pairs: string[] = [];
  for (const key of sortedKeys) {
    const values = params.getAll(key).sort();
    for (const val of values) {
      pairs.push(`${encodeURIComponent(key)}=${encodeURIComponent(val)}`);
    }
  }

  return pairs.length > 0 ? `?${pairs.join('&')}` : '';
}

/**
 * Retrieves header value case-insensitively.
 */
function getHeaderCaseInsensitive(
  headers: Record<string, string | string[] | undefined>,
  name: string
): string | string[] | undefined {
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) {
      return v;
    }
  }
  return undefined;
}

/**
 * Normalizes Vary headers from request headers.
 */
export function extractNormalizedVaryHeaders(
  headers: Record<string, string | string[] | undefined>,
  varyBy?: readonly string[]
): string {
  if (!varyBy || varyBy.length === 0) {
    return '';
  }

  const sortedVaryNames = [...varyBy]
    .map((name) => name.toLowerCase().trim())
    .filter((name) => name.length > 0)
    .sort();

  const parts: string[] = [];
  for (const name of sortedVaryNames) {
    const rawVal = getHeaderCaseInsensitive(headers, name);
    if (rawVal !== undefined && rawVal !== null) {
      const valStr = Array.isArray(rawVal) ? rawVal.join(',') : String(rawVal);
      parts.push(`${name}:${valStr.trim()}`);
    } else {
      parts.push(`${name}:<unset>`);
    }
  }

  return parts.join('|');
}

/**
 * Generates deterministic cache key for a route request.
 */
export function generateCacheKey(options: GenerateCacheKeyOptions): GeneratedCacheKey {
  const {
    keyPrefix = 'routex:',
    routeId,
    method,
    pathname,
    search,
    headers,
    varyBy,
    identityId,
  } = options;

  const normMethod = method.toUpperCase().trim();
  const normPath = pathname.trim();
  const normQuery = normalizeQueryString(search);
  const normVary = extractNormalizedVaryHeaders(headers, varyBy);

  // Hash identity if provided (so credentials or IDs never appear plaintext in Redis keys)
  const identityHash = identityId
    ? createHash('sha256').update(identityId).digest('hex').slice(0, 16)
    : 'anon';

  // Compute canonical digest string
  const canonicalString = [
    normMethod,
    normPath,
    normQuery,
    normVary,
    identityHash,
  ].join('::');

  const keyHash = createHash('sha256').update(canonicalString).digest('hex');
  const cacheKey = `${keyPrefix}cache:${routeId}:${keyHash}`;

  return {
    cacheKey,
    keyHash,
  };
}
