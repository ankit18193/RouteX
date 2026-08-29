import type { IncomingHttpHeaders, OutgoingHttpHeaders } from 'node:http';
import { sanitizeHeaderValue } from '../utils/uuid.js';

/**
 * Standard RFC 7230 / RFC 9110 Hop-by-Hop headers.
 */
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'http2-settings',
  'proxy-connection',
]);

/**
 * Internal/identity headers that must never be accepted directly from untrusted clients.
 */
const UNTRUSTED_INCOMING_HEADERS = new Set([
  'x-user-id',
  'x-user-roles',
  'x-auth-type',
  'x-auth-claims',
  'x-gateway-forwarded-by',
  'x-gateway-auth-status',
]);

export interface RequestHeaderSanitizeOptions {
  readonly clientIp: string;
  readonly requestId: string;
  readonly targetHost: string;
  readonly originalHost?: string | undefined;
  readonly proto?: string | undefined;
}

/**
 * Parse Connection header tokens and return full set of headers to strip for this request.
 */
export function getHopByHopHeaders(headers: IncomingHttpHeaders | Record<string, string | string[] | undefined>): Set<string> {
  const hopByHop = new Set(HOP_BY_HOP_HEADERS);

  const connectionHeader = headers['connection'];
  if (typeof connectionHeader === 'string') {
    const tokens = connectionHeader.split(',').map((t) => t.trim().toLowerCase());
    for (const token of tokens) {
      if (token.length > 0) {
        hopByHop.add(token);
      }
    }
  } else if (Array.isArray(connectionHeader)) {
    for (const item of connectionHeader) {
      if (typeof item === 'string') {
        const tokens = item.split(',').map((t) => t.trim().toLowerCase());
        for (const token of tokens) {
          if (token.length > 0) {
            hopByHop.add(token);
          }
        }
      }
    }
  }

  return hopByHop;
}

/**
 * Prepare and sanitize downstream headers for safe forwarding to upstream.
 */
export function sanitizeRequestHeaders(
  headers: IncomingHttpHeaders | Record<string, string | string[] | undefined>,
  options: RequestHeaderSanitizeOptions
): Record<string, string | string[]> {
  const hopByHop = getHopByHopHeaders(headers);
  const sanitized: Record<string, string | string[]> = {};

  for (const [rawKey, rawValue] of Object.entries(headers)) {
    if (rawValue === undefined) {
      continue;
    }

    const key = rawKey.toLowerCase().trim();

    // 1. Strip standard and dynamic Connection-token hop-by-hop headers
    if (hopByHop.has(key)) {
      continue;
    }

    // 2. Strip untrusted identity & internal gateway headers sent by client
    if (UNTRUSTED_INCOMING_HEADERS.has(key) || key.startsWith('x-gateway-')) {
      continue;
    }

    // 3. Strip CRLF characters from string/array values to prevent header injection
    if (typeof rawValue === 'string') {
      sanitized[key] = sanitizeHeaderValue(rawValue);
    } else if (Array.isArray(rawValue)) {
      sanitized[key] = rawValue.map((v) => sanitizeHeaderValue(v));
    }
  }

  // 4. Overwrite Host header to target upstream host
  sanitized['host'] = options.targetHost;

  // 5. Inject trusted request ID & correlation headers
  sanitized['x-request-id'] = options.requestId;

  // 6. Inject X-Forwarded-* headers
  const existingXff = headers['x-forwarded-for'];
  if (typeof existingXff === 'string' && existingXff.trim().length > 0) {
    sanitized['x-forwarded-for'] = `${existingXff.trim()}, ${options.clientIp}`;
  } else {
    sanitized['x-forwarded-for'] = options.clientIp;
  }

  sanitized['x-forwarded-proto'] = options.proto ?? 'http';

  if (options.originalHost) {
    sanitized['x-forwarded-host'] = sanitizeHeaderValue(options.originalHost);
  }

  sanitized['x-gateway-forwarded-by'] = 'routex';

  return sanitized;
}

/**
 * Sanitize upstream response headers before streaming back to client.
 */
export function sanitizeResponseHeaders(
  upstreamHeaders: OutgoingHttpHeaders | Record<string, string | string[] | number | undefined>,
  requestId: string
): Record<string, string | string[]> {
  const sanitized: Record<string, string | string[]> = {};

  const hopByHop = new Set(HOP_BY_HOP_HEADERS);
  const connHeader = upstreamHeaders['connection'];
  if (typeof connHeader === 'string') {
    const tokens = connHeader.split(',').map((t) => t.trim().toLowerCase());
    for (const token of tokens) {
      if (token.length > 0) {
        hopByHop.add(token);
      }
    }
  }

  for (const [rawKey, rawValue] of Object.entries(upstreamHeaders)) {
    if (rawValue === undefined) {
      continue;
    }

    const key = rawKey.toLowerCase().trim();

    if (hopByHop.has(key)) {
      continue;
    }

    if (typeof rawValue === 'string' || typeof rawValue === 'number') {
      sanitized[key] = String(rawValue);
    } else if (Array.isArray(rawValue)) {
      sanitized[key] = rawValue.map(String);
    }
  }

  // Ensure request ID is always returned in response header
  sanitized['x-request-id'] = requestId;

  return sanitized;
}
