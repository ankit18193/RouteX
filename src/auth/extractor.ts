import type { IncomingHttpHeaders } from 'node:http';
import type { ExtractedCredentials } from './types.js';
import { UnauthorizedError } from '../errors/gateway-error.js';

/**
 * Extract and classify authentication credentials from HTTP request headers.
 * Supports:
 *   1. X-API-Key: <key>
 *   2. Authorization: Bearer <jwt | rx_live_key>
 *
 * Deterministic precedence: When both headers are supplied, X-API-Key takes precedence.
 * Never exposes or logs raw credentials.
 */
export function extractCredentials(
  headers: IncomingHttpHeaders | Record<string, string | string[] | undefined>
): ExtractedCredentials | null {
  const apiKeyHeader = getHeaderString(headers, 'x-api-key');
  const authHeader = getHeaderString(headers, 'authorization');

  // 1. Check X-API-Key (highest precedence)
  if (apiKeyHeader !== undefined) {
    const rawKey = apiKeyHeader.trim();
    if (rawKey.length === 0) {
      throw new UnauthorizedError('Empty API key provided in X-API-Key header');
    }
    if (rawKey.includes('\r') || rawKey.includes('\n') || rawKey.includes(' ')) {
      throw new UnauthorizedError('Malformed API key provided in X-API-Key header');
    }
    return {
      type: 'api-key',
      rawToken: rawKey,
      source: 'x-api-key',
    };
  }

  // 2. Check Authorization header
  if (authHeader !== undefined) {
    const trimmedAuth = authHeader.trim();
    if (trimmedAuth.length === 0) {
      throw new UnauthorizedError('Empty Authorization header provided');
    }

    const match = /^Bearer\s+(\S+)$/i.exec(trimmedAuth);
    if (!match || !match[1]) {
      throw new UnauthorizedError(
        'Malformed Authorization header: expected format Bearer <token>'
      );
    }

    const rawToken = match[1].trim();
    if (rawToken.length === 0) {
      throw new UnauthorizedError('Empty token provided in Authorization header');
    }

    // Classify whether bearer token is an API key (rx_live_...) or JWT
    if (rawToken.startsWith('rx_live_')) {
      return {
        type: 'api-key',
        rawToken,
        source: 'authorization-bearer',
      };
    }

    return {
      type: 'jwt',
      rawToken,
      source: 'authorization-bearer',
    };
  }

  return null;
}

function getHeaderString(
  headers: IncomingHttpHeaders | Record<string, string | string[] | undefined>,
  key: string
): string | undefined {
  const direct = headers[key];
  if (typeof direct === 'string') {
    return direct;
  }
  if (Array.isArray(direct) && direct.length > 0 && typeof direct[0] === 'string') {
    return direct[0];
  }

  const lowercaseKey = key.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lowercaseKey) {
      if (typeof v === 'string') {
        return v;
      }
      if (Array.isArray(v) && v.length > 0 && typeof v[0] === 'string') {
        return v[0];
      }
    }
  }

  return undefined;
}
