import { ZodError } from 'zod';
import { GatewayErrorCode } from './error-codes.js';
import { GatewayError, TooManyRequestsError, ServiceUnavailableError } from './gateway-error.js';
import type { ErrorEnvelope } from '../types/index.js';

export interface FormattedErrorResponse {
  readonly statusCode: number;
  readonly envelope: ErrorEnvelope;
  readonly headers: Record<string, string>;
}

export function createErrorEnvelope(
  error: unknown,
  fallbackRequestId = 'req_unknown'
): FormattedErrorResponse {
  const timestamp = new Date().toISOString();
  const headers: Record<string, string> = {
    'content-type': 'application/json; charset=utf-8',
  };

  // Case 1: RouteX GatewayError instance
  if (error instanceof GatewayError) {
    const requestId = error.requestId ?? fallbackRequestId;
    headers['x-request-id'] = requestId;

    if (error instanceof TooManyRequestsError && error.retryAfterSec !== undefined) {
      headers['retry-after'] = String(error.retryAfterSec);
    } else if (error instanceof ServiceUnavailableError && error.retryAfterSec !== undefined) {
      headers['retry-after'] = String(error.retryAfterSec);
    }

    const envelope: ErrorEnvelope = {
      error: error.code,
      message: error.message,
      statusCode: error.statusCode,
      requestId,
      timestamp,
      ...(error.details !== undefined ? { details: error.details } : {}),
    };

    return {
      statusCode: error.statusCode,
      envelope,
      headers,
    };
  }

  // Case 2: Zod validation error
  if (error instanceof ZodError) {
    const requestId = fallbackRequestId;
    headers['x-request-id'] = requestId;

    const formattedIssues = error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
      code: issue.code,
    }));

    const envelope: ErrorEnvelope = {
      error: GatewayErrorCode.BAD_REQUEST,
      message: 'Request validation failed',
      statusCode: 400,
      requestId,
      timestamp,
      details: { issues: formattedIssues },
    };

    return {
      statusCode: 400,
      envelope,
      headers,
    };
  }

  // Case 3: Direct or Wrapped Network/System Error (ECONNREFUSED, ETIMEDOUT, UND_ERR_*, etc.)
  const networkError = extractNetworkErrorInfo(error);
  if (networkError) {
    const requestId = fallbackRequestId;
    headers['x-request-id'] = requestId;

    const code = networkError.isTimeout
      ? GatewayErrorCode.GATEWAY_TIMEOUT
      : GatewayErrorCode.BAD_GATEWAY;
    const statusCode = networkError.isTimeout ? 504 : 502;
    const message = networkError.isTimeout
      ? `Upstream connection timed out (${networkError.code})`
      : `Upstream connection failed (${networkError.code})`;

    const envelope: ErrorEnvelope = {
      error: code,
      message,
      statusCode,
      requestId,
      timestamp,
      details: { systemCode: networkError.code },
    };

    return {
      statusCode,
      envelope,
      headers,
    };
  }

  // Case 4: Generic / Unhandled JavaScript Error
  const requestId = fallbackRequestId;
  headers['x-request-id'] = requestId;
  const rawMessage = error instanceof Error ? error.message : 'An unexpected error occurred';

  const envelope: ErrorEnvelope = {
    error: GatewayErrorCode.INTERNAL_SERVER_ERROR,
    message: rawMessage,
    statusCode: 500,
    requestId,
    timestamp,
  };

  return {
    statusCode: 500,
    envelope,
    headers,
  };
}

interface NetworkErrorInfo {
  readonly code: string;
  readonly isTimeout: boolean;
}

const TIMEOUT_CODES = new Set([
  'ETIMEDOUT',
  'ESOCKETTIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_RESPONSE_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
]);

const CONNECTION_FAILURE_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNRESET',
  'EPIPE',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_SOCKET',
  'UND_ERR_ABORTED',
  'UND_ERR_DESTROYED',
]);

/**
 * Inspect direct and nested error cause chains to identify network and system errors.
 */
function extractNetworkErrorInfo(error: unknown): NetworkErrorInfo | null {
  if (!error || typeof error !== 'object') {
    return null;
  }

  const err = error as Record<string, unknown>;
  const cause = err.cause && typeof err.cause === 'object' ? (err.cause as Record<string, unknown>) : null;
  const innerCause = cause?.cause && typeof cause.cause === 'object' ? (cause.cause as Record<string, unknown>) : null;

  const candidateCodes = [
    typeof err.code === 'string' ? err.code : undefined,
    typeof cause?.code === 'string' ? cause.code : undefined,
    typeof innerCause?.code === 'string' ? innerCause.code : undefined,
  ].filter((c): c is string => c !== undefined);

  for (const code of candidateCodes) {
    if (TIMEOUT_CODES.has(code)) {
      return { code, isTimeout: true };
    }
    if (CONNECTION_FAILURE_CODES.has(code)) {
      return { code, isTimeout: false };
    }
  }

  const candidateNames = [
    typeof err.name === 'string' ? err.name : undefined,
    typeof cause?.name === 'string' ? cause.name : undefined,
  ].filter((n): n is string => n !== undefined);

  for (const name of candidateNames) {
    if (name === 'TimeoutError' || name === 'ConnectTimeoutError' || name === 'ResponseTimeoutError') {
      return { code: candidateCodes[0] ?? name, isTimeout: true };
    }
  }

  return null;
}
