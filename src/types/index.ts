/**
 * Core type definitions for RouteX API Gateway
 */

export type {
  HttpMethod,
  AuthMode,
  RateLimitFailurePolicy,
  LogLevel,
  LogFormat,
  ServerConfig,
  RedisConfig,
  RouteAuthPolicy,
  RouteRateLimitPolicy,
  RouteTimeoutPolicy,
  RouteDefinition,
  GatewayConfig,
} from '../config/schema.js';

export interface LatencyBreakdown {
  readonly totalDurationMs: number;
  readonly upstreamLatencyMs: number;
  readonly gatewayOverheadMs: number;
}

export interface ErrorEnvelope {
  readonly error: string;
  readonly message: string;
  readonly statusCode: number;
  readonly requestId: string;
  readonly timestamp: string;
  readonly details?: unknown;
}
