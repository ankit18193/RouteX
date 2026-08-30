import { pino, type Logger, type LoggerOptions } from 'pino';
import type { LogLevel, LogFormat } from '../types/index.js';

export interface LoggerConfig {
  readonly level?: LogLevel | undefined;
  readonly format?: LogFormat | undefined;
  readonly name?: string | undefined;
}

export interface RequestLogContext {
  readonly requestId: string;
  readonly routeId?: string | undefined;
  readonly clientIp?: string | undefined;
  readonly method?: string | undefined;
  readonly path?: string | undefined;
  readonly userId?: string | undefined;
}

export interface AccessLogData {
  readonly requestId: string;
  readonly method: string;
  readonly url: string;
  readonly statusCode: number;
  readonly routeId?: string | undefined;
  readonly totalDurationMs: number;
  readonly upstreamLatencyMs?: number | undefined;
  readonly gatewayOverheadMs?: number | undefined;
  readonly clientIp?: string | undefined;
  readonly userAgent?: string | undefined;
  readonly contentLength?: number | undefined;
  readonly cacheStatus?: 'HIT' | 'MISS' | 'BYPASS' | 'STORE_FAILED' | undefined;
  readonly cacheKeyHash?: string | undefined;
  readonly circuitState?: 'CLOSED' | 'OPEN' | 'HALF_OPEN' | undefined;
  readonly circuitRejected?: boolean | undefined;
}

const DEFAULT_REDACT_PATHS = [
  // HTTP Headers (common casing variations)
  'headers.authorization',
  'headers.Authorization',
  'headers.AUTHORIZATION',
  'headers["x-api-key"]',
  'headers["X-API-KEY"]',
  'headers["X-Api-Key"]',
  'headers["x-auth-token"]',
  'headers["X-Auth-Token"]',
  'headers.cookie',
  'headers.Cookie',
  'headers["set-cookie"]',
  'headers["Set-Cookie"]',
  'headers["proxy-authorization"]',
  'headers["Proxy-Authorization"]',

  // Deep property wildcard matches for credentials and secrets
  '*.authorization',
  '*.Authorization',
  '*.password',
  '*.Password',
  '*.PASSWORD',
  '*.pass',
  '*.secret',
  '*.Secret',
  '*.SECRET',
  '*.client_secret',
  '*.clientSecret',
  '*.token',
  '*.Token',
  '*.TOKEN',
  '*.accessToken',
  '*.access_token',
  '*.refreshToken',
  '*.refresh_token',
  '*.apiKey',
  '*.ApiKey',
  '*.api_key',
  '*.API_KEY',
  '*.jwt',
  '*.privateKey',
  '*.private_key',
];

/**
 * Factory to create a configured Pino logger instance
 */
export function createLogger(config: LoggerConfig = {}): Logger {
  const level = config.level ?? 'info';
  const format = config.format ?? 'json';
  const name = config.name ?? 'routex';

  const baseOptions: LoggerOptions = {
    name,
    level,
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: DEFAULT_REDACT_PATHS,
      censor: '[REDACTED]',
    },
    formatters: {
      level(label) {
        return { level: label };
      },
    },
  };

  if (format === 'pretty') {
    return pino({
      ...baseOptions,
      transport: {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:standard',
          ignore: 'pid,hostname',
        },
      },
    });
  }

  return pino(baseOptions);
}

/**
 * Create a request-scoped child logger containing correlation metadata
 */
export function createRequestLogger(parentLogger: Logger, context: RequestLogContext): Logger {
  return parentLogger.child({
    reqId: context.requestId,
    ...(context.routeId ? { routeId: context.routeId } : {}),
    ...(context.clientIp ? { clientIp: context.clientIp } : {}),
    ...(context.method ? { method: context.method } : {}),
    ...(context.path ? { path: context.path } : {}),
    ...(context.userId ? { userId: context.userId } : {}),
  });
}

/**
 * Log structured HTTP access record with latency breakdown
 */
export function logAccess(logger: Logger, data: AccessLogData): void {
  const level: LogLevel = data.statusCode >= 500 ? 'error' : data.statusCode >= 400 ? 'warn' : 'info';

  logger[level]({
    type: 'ACCESS_LOG',
    requestId: data.requestId,
    method: data.method,
    url: data.url,
    statusCode: data.statusCode,
    routeId: data.routeId ?? 'unmatched',
    totalDurationMs: data.totalDurationMs,
    upstreamLatencyMs: data.upstreamLatencyMs ?? 0,
    gatewayOverheadMs: data.gatewayOverheadMs ?? data.totalDurationMs,
    clientIp: data.clientIp ?? 'unknown',
    userAgent: data.userAgent ?? 'unknown',
    contentLength: data.contentLength,
    ...(data.cacheStatus ? { cache_status: data.cacheStatus } : {}),
    ...(data.cacheKeyHash ? { cache_key_hash: data.cacheKeyHash } : {}),
    ...(data.circuitState ? { circuit_state: data.circuitState } : {}),
    ...(data.circuitRejected !== undefined ? { circuit_rejected: data.circuitRejected } : {}),
  }, `${data.method} ${data.url} ${data.statusCode} in ${data.totalDurationMs}ms (gw: ${data.gatewayOverheadMs ?? 0}ms, up: ${data.upstreamLatencyMs ?? 0}ms)`);
}
