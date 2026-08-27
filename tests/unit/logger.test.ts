import { describe, it, expect } from 'vitest';
import { createLogger, createRequestLogger, logAccess } from '../../src/logger/logger.js';
import * as LoggerModule from '../../src/logger/index.js';

describe('Structured Logger (Pino)', () => {
  it('should export all logger symbols from index.ts', () => {
    expect(LoggerModule.createLogger).toBeDefined();
    expect(LoggerModule.createRequestLogger).toBeDefined();
    expect(LoggerModule.logAccess).toBeDefined();
  });

  it('should create a logger with default settings', () => {
    const logger = createLogger();
    expect(logger).toBeDefined();
    expect(logger.level).toBe('info');
  });

  it('should create a logger with custom log level and name', () => {
    const logger = createLogger({
      level: 'debug',
      name: 'routex-custom',
    });
    expect(logger.level).toBe('debug');
  });

  it('should create pretty-print logger in development mode', () => {
    const logger = createLogger({
      level: 'info',
      format: 'pretty',
    });
    expect(logger).toBeDefined();
  });

  it('should create request-scoped child logger', () => {
    const parent = createLogger({ level: 'silent' });
    const child = createRequestLogger(parent, {
      requestId: 'req_123',
      routeId: 'user_service',
      clientIp: '192.168.1.1',
      method: 'GET',
      path: '/api/v1/users/me',
      userId: 'usr_abc',
    });

    expect(child).toBeDefined();
  });

  it('should log access records without throwing', () => {
    const logger = createLogger({ level: 'silent' });
    expect(() => {
      logAccess(logger, {
        requestId: 'req_test_1',
        method: 'POST',
        url: '/api/v1/chats',
        statusCode: 201,
        routeId: 'chat_service',
        totalDurationMs: 35.4,
        upstreamLatencyMs: 32.1,
        gatewayOverheadMs: 3.3,
        clientIp: '127.0.0.1',
        userAgent: 'curl/7.68.0',
        contentLength: 1024,
      });
    }).not.toThrow();

    // 4xx status
    expect(() => {
      logAccess(logger, {
        requestId: 'req_test_2',
        method: 'GET',
        url: '/unknown',
        statusCode: 404,
        totalDurationMs: 1.2,
      });
    }).not.toThrow();

    // 5xx status
    expect(() => {
      logAccess(logger, {
        requestId: 'req_test_3',
        method: 'GET',
        url: '/api/v1/users',
        statusCode: 502,
        totalDurationMs: 1002.5,
      });
    }).not.toThrow();
  });
});
