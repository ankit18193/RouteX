import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  GatewayErrorCode,
  BadRequestError,
  UnauthorizedError,
  ForbiddenError,
  NotFoundError,
  RouteNotFoundError,
  TooManyRequestsError,
  BadGatewayError,
  ServiceUnavailableError,
  GatewayTimeoutError,
  ConfigurationError,
  createErrorEnvelope,
} from '../../src/errors/index.js';
import * as ErrorsModule from '../../src/errors/index.js';

describe('Error Envelopes & Domain Errors', () => {
  it('should export all error symbols from index.ts', () => {
    expect(ErrorsModule.GatewayError).toBeDefined();
    expect(ErrorsModule.createErrorEnvelope).toBeDefined();
    expect(ErrorsModule.GatewayErrorCode).toBeDefined();
  });

  describe('GatewayError Subclasses', () => {
    it('should initialize BadRequestError with status 400', () => {
      const err = new BadRequestError('Invalid payload', { field: 'email' }, 'req_123');
      expect(err.statusCode).toBe(400);
      expect(err.code).toBe(GatewayErrorCode.BAD_REQUEST);
      expect(err.message).toBe('Invalid payload');
      expect(err.requestId).toBe('req_123');
      expect(err.details).toEqual({ field: 'email' });
    });

    it('should initialize UnauthorizedError with status 401', () => {
      const err = new UnauthorizedError('Token expired', undefined, 'req_456');
      expect(err.statusCode).toBe(401);
      expect(err.code).toBe(GatewayErrorCode.UNAUTHORIZED);
    });

    it('should initialize ForbiddenError with status 403', () => {
      const err = new ForbiddenError('Insufficient permissions');
      expect(err.statusCode).toBe(403);
      expect(err.code).toBe(GatewayErrorCode.FORBIDDEN);
    });

    it('should initialize NotFoundError with status 404', () => {
      const err = new NotFoundError('Resource missing');
      expect(err.statusCode).toBe(404);
      expect(err.code).toBe(GatewayErrorCode.NOT_FOUND);
    });

    it('should initialize RouteNotFoundError with status 404', () => {
      const err = new RouteNotFoundError('/api/unknown', 'GET', 'req_789');
      expect(err.statusCode).toBe(404);
      expect(err.code).toBe(GatewayErrorCode.ROUTE_NOT_FOUND);
      expect(err.details).toEqual({ path: '/api/unknown', method: 'GET' });
    });

    it('should initialize TooManyRequestsError with status 429 and retryAfterSec', () => {
      const err = new TooManyRequestsError('Rate limit exceeded', 60, undefined, 'req_rl');
      expect(err.statusCode).toBe(429);
      expect(err.code).toBe(GatewayErrorCode.TOO_MANY_REQUESTS);
      expect(err.retryAfterSec).toBe(60);
    });

    it('should initialize BadGatewayError with status 502', () => {
      const cause = new Error('ECONNREFUSED');
      const err = new BadGatewayError('Upstream connection failed', cause);
      expect(err.statusCode).toBe(502);
      expect(err.code).toBe(GatewayErrorCode.BAD_GATEWAY);
      expect(err.cause).toBe(cause);
    });

    it('should initialize ServiceUnavailableError with status 503', () => {
      const err = new ServiceUnavailableError('Redis is down', GatewayErrorCode.RATE_LIMIT_UNAVAILABLE, 10);
      expect(err.statusCode).toBe(503);
      expect(err.code).toBe(GatewayErrorCode.RATE_LIMIT_UNAVAILABLE);
      expect(err.retryAfterSec).toBe(10);
    });

    it('should initialize GatewayTimeoutError with status 504', () => {
      const err = new GatewayTimeoutError('Upstream took too long');
      expect(err.statusCode).toBe(504);
      expect(err.code).toBe(GatewayErrorCode.GATEWAY_TIMEOUT);
    });

    it('should initialize ConfigurationError with status 500', () => {
      const err = new ConfigurationError('Config missing');
      expect(err.statusCode).toBe(500);
      expect(err.code).toBe(GatewayErrorCode.CONFIGURATION_ERROR);
    });
  });

  describe('createErrorEnvelope Function', () => {
    it('should format GatewayError into a standard envelope', () => {
      const err = new TooManyRequestsError('Rate limit exceeded', 30, { limit: 100 }, 'req_abc');
      const response = createErrorEnvelope(err);

      expect(response.statusCode).toBe(429);
      expect(response.headers['content-type']).toContain('application/json');
      expect(response.headers['x-request-id']).toBe('req_abc');
      expect(response.headers['retry-after']).toBe('30');
      expect(response.envelope).toMatchObject({
        error: 'TOO_MANY_REQUESTS',
        message: 'Rate limit exceeded',
        statusCode: 429,
        requestId: 'req_abc',
        details: { limit: 100 },
      });
      expect(typeof response.envelope.timestamp).toBe('string');
    });

    it('should attach retry-after header for ServiceUnavailableError with retryAfterSec', () => {
      const err = new ServiceUnavailableError('Overloaded', GatewayErrorCode.SERVICE_UNAVAILABLE, 15, undefined, 'req_503');
      const response = createErrorEnvelope(err);

      expect(response.statusCode).toBe(503);
      expect(response.headers['retry-after']).toBe('15');
      expect(response.headers['x-request-id']).toBe('req_503');
    });

    it('should format ZodError into a structured 400 envelope', () => {
      const schema = z.object({ age: z.number() });
      const result = schema.safeParse({ age: 'not-a-number' });
      expect(result.success).toBe(false);

      if (!result.success) {
        const response = createErrorEnvelope(result.error, 'req_zod_1');
        expect(response.statusCode).toBe(400);
        expect(response.envelope.error).toBe(GatewayErrorCode.BAD_REQUEST);
        expect(response.envelope.requestId).toBe('req_zod_1');
        expect(response.envelope.details).toHaveProperty('issues');
      }
    });

    it('should format direct Node.js ECONNREFUSED system error into 502 envelope', () => {
      const sysErr: any = new Error('connect ECONNREFUSED 127.0.0.1:4001');
      sysErr.code = 'ECONNREFUSED';

      const response = createErrorEnvelope(sysErr, 'req_sys_1');
      expect(response.statusCode).toBe(502);
      expect(response.envelope.error).toBe(GatewayErrorCode.BAD_GATEWAY);
      expect(response.envelope.message).toContain('ECONNREFUSED');
      expect(response.envelope.requestId).toBe('req_sys_1');
    });

    it('should format wrapped system error inside error.cause into 502 envelope', () => {
      const innerCause: any = new Error('connect ECONNREFUSED 127.0.0.1:4001');
      innerCause.code = 'ECONNREFUSED';
      const wrappedError = new TypeError('fetch failed', { cause: innerCause });

      const response = createErrorEnvelope(wrappedError, 'req_wrapped_1');
      expect(response.statusCode).toBe(502);
      expect(response.envelope.error).toBe(GatewayErrorCode.BAD_GATEWAY);
      expect(response.envelope.message).toContain('ECONNREFUSED');
    });

    it('should format direct Node.js ETIMEDOUT system error into 504 envelope', () => {
      const sysErr: any = new Error('connect ETIMEDOUT');
      sysErr.code = 'ETIMEDOUT';

      const response = createErrorEnvelope(sysErr, 'req_sys_2');
      expect(response.statusCode).toBe(504);
      expect(response.envelope.error).toBe(GatewayErrorCode.GATEWAY_TIMEOUT);
      expect(response.envelope.message).toContain('ETIMEDOUT');
    });

    it('should format wrapped timeout inside error.cause into 504 envelope', () => {
      const innerCause: any = new Error('Headers Timeout Error');
      innerCause.code = 'UND_ERR_HEADERS_TIMEOUT';
      const wrappedTimeout = new Error('Request failed', { cause: innerCause });

      const response = createErrorEnvelope(wrappedTimeout, 'req_wrapped_timeout');
      expect(response.statusCode).toBe(504);
      expect(response.envelope.error).toBe(GatewayErrorCode.GATEWAY_TIMEOUT);
      expect(response.envelope.message).toContain('UND_ERR_HEADERS_TIMEOUT');
    });

    it('should format ConnectTimeoutError name into 504 envelope', () => {
      const timeoutErr = new Error('Connect timeout');
      timeoutErr.name = 'ConnectTimeoutError';

      const response = createErrorEnvelope(timeoutErr, 'req_timeout_name');
      expect(response.statusCode).toBe(504);
      expect(response.envelope.error).toBe(GatewayErrorCode.GATEWAY_TIMEOUT);
    });

    it('should format generic unhandled Error into 500 envelope', () => {
      const genericErr = new Error('Unexpected crash');
      const response = createErrorEnvelope(genericErr, 'req_gen_1');

      expect(response.statusCode).toBe(500);
      expect(response.envelope.error).toBe(GatewayErrorCode.INTERNAL_SERVER_ERROR);
      expect(response.envelope.message).toBe('Unexpected crash');
      expect(response.envelope.requestId).toBe('req_gen_1');
    });

    it('should handle non-Error throwables gracefully', () => {
      const response = createErrorEnvelope('A string error', 'req_str_1');
      expect(response.statusCode).toBe(500);
      expect(response.envelope.error).toBe(GatewayErrorCode.INTERNAL_SERVER_ERROR);
      expect(response.envelope.message).toBe('An unexpected error occurred');
    });
  });
});
