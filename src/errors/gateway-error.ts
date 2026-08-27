import { GatewayErrorCode, GatewayErrorStatusMap } from './error-codes.js';

export interface GatewayErrorOptions {
  readonly message: string;
  readonly code?: GatewayErrorCode | undefined;
  readonly statusCode?: number | undefined;
  readonly requestId?: string | undefined;
  readonly details?: unknown;
  readonly cause?: Error | undefined;
}

export class GatewayError extends Error {
  public readonly code: GatewayErrorCode;
  public readonly statusCode: number;
  public readonly requestId?: string | undefined;
  public readonly details?: unknown;
  public readonly isGatewayError = true;

  constructor(options: GatewayErrorOptions) {
    super(options.message);
    this.name = this.constructor.name;
    this.code = options.code ?? GatewayErrorCode.INTERNAL_SERVER_ERROR;
    this.statusCode = options.statusCode ?? GatewayErrorStatusMap[this.code] ?? 500;
    this.requestId = options.requestId;
    this.details = options.details;

    if (options.cause) {
      this.cause = options.cause;
    }

    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }
}

export class BadRequestError extends GatewayError {
  constructor(message = 'Bad Request', details?: unknown, requestId?: string | undefined) {
    super({
      message,
      code: GatewayErrorCode.BAD_REQUEST,
      statusCode: 400,
      details,
      requestId,
    });
  }
}

export class UnauthorizedError extends GatewayError {
  constructor(message = 'Unauthorized', details?: unknown, requestId?: string | undefined) {
    super({
      message,
      code: GatewayErrorCode.UNAUTHORIZED,
      statusCode: 401,
      details,
      requestId,
    });
  }
}

export class ForbiddenError extends GatewayError {
  constructor(message = 'Forbidden', details?: unknown, requestId?: string | undefined) {
    super({
      message,
      code: GatewayErrorCode.FORBIDDEN,
      statusCode: 403,
      details,
      requestId,
    });
  }
}

export class NotFoundError extends GatewayError {
  constructor(message = 'Not Found', details?: unknown, requestId?: string | undefined) {
    super({
      message,
      code: GatewayErrorCode.NOT_FOUND,
      statusCode: 404,
      details,
      requestId,
    });
  }
}

export class RouteNotFoundError extends GatewayError {
  constructor(path: string, method: string, requestId?: string | undefined) {
    super({
      message: `No matching upstream route configured for ${method} ${path}`,
      code: GatewayErrorCode.ROUTE_NOT_FOUND,
      statusCode: 404,
      details: { path, method },
      requestId,
    });
  }
}

export class TooManyRequestsError extends GatewayError {
  public readonly retryAfterSec?: number | undefined;

  constructor(
    message = 'Too Many Requests',
    retryAfterSec?: number | undefined,
    details?: unknown,
    requestId?: string | undefined
  ) {
    super({
      message,
      code: GatewayErrorCode.TOO_MANY_REQUESTS,
      statusCode: 429,
      details,
      requestId,
    });
    this.retryAfterSec = retryAfterSec;
  }
}

export class BadGatewayError extends GatewayError {
  constructor(
    message = 'Bad Gateway: Upstream service unavailable or returned invalid response',
    cause?: Error | undefined,
    details?: unknown,
    requestId?: string | undefined
  ) {
    super({
      message,
      code: GatewayErrorCode.BAD_GATEWAY,
      statusCode: 502,
      cause,
      details,
      requestId,
    });
  }
}

export class ServiceUnavailableError extends GatewayError {
  public readonly retryAfterSec?: number | undefined;

  constructor(
    message = 'Service Unavailable',
    code: GatewayErrorCode = GatewayErrorCode.SERVICE_UNAVAILABLE,
    retryAfterSec?: number | undefined,
    details?: unknown,
    requestId?: string | undefined
  ) {
    super({
      message,
      code,
      statusCode: 503,
      details,
      requestId,
    });
    this.retryAfterSec = retryAfterSec;
  }
}

export class GatewayTimeoutError extends GatewayError {
  constructor(
    message = 'Gateway Timeout: Upstream response timed out',
    details?: unknown,
    requestId?: string | undefined
  ) {
    super({
      message,
      code: GatewayErrorCode.GATEWAY_TIMEOUT,
      statusCode: 504,
      details,
      requestId,
    });
  }
}

export class ConfigurationError extends GatewayError {
  constructor(message: string, details?: unknown) {
    super({
      message,
      code: GatewayErrorCode.CONFIGURATION_ERROR,
      statusCode: 500,
      details,
    });
  }
}
