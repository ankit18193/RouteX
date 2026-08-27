import { randomUUID } from 'node:crypto';

/**
 * Generate a new cryptographically random Request ID prefixed with 'req_'
 */
export function generateRequestId(): string {
  return `req_${randomUUID()}`;
}

/**
 * Check if a string is a valid, safe Request ID format
 * Allows alphanumeric, dashes, underscores, dots, and colons (max 128 chars)
 */
export function isValidRequestId(id: string): boolean {
  if (!id || typeof id !== 'string' || id.length > 128) {
    return false;
  }
  // Disallow CRLF or whitespace characters strictly
  return /^[a-zA-Z0-9_\-.:]{1,128}$/.test(id);
}

/**
 * Normalize an incoming X-Request-Id header:
 * - If valid and safe, sanitize and return it
 * - If invalid or absent, generate a fresh unique Request ID
 */
export function normalizeRequestId(incomingHeader?: string | string[] | undefined): string {
  if (!incomingHeader) {
    return generateRequestId();
  }

  const candidate = Array.isArray(incomingHeader) ? incomingHeader[0] : incomingHeader;
  if (!candidate) {
    return generateRequestId();
  }

  const trimmed = candidate.trim();
  if (isValidRequestId(trimmed)) {
    return trimmed;
  }

  return generateRequestId();
}

/**
 * Sanitize any string against CRLF header injection
 */
export function sanitizeHeaderValue(value: string): string {
  if (typeof value !== 'string') {
    return '';
  }
  return value.replace(/[\r\n\0]/g, '').trim();
}
