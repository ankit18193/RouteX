import type { RateLimitFailurePolicy } from '../config/schema.js';

export type RateLimitNamespace = 'ip' | 'user' | 'key';

export type { RateLimitFailurePolicy };

export interface RateLimitRequest {
  readonly namespace: RateLimitNamespace;
  readonly identifier: string;
  readonly routeId: string;
  readonly windowSec: number;
  readonly limit: number;
  readonly nowMs?: number | undefined;
}

export interface RateLimitResult {
  readonly allowed: boolean;
  readonly limit: number;
  readonly remaining: number;
  readonly resetAt: number; // Unix timestamp in seconds
  readonly retryAfterSec: number;
  readonly degraded?: boolean | undefined;
}

export interface RateLimitHeaders {
  readonly 'x-ratelimit-limit': string;
  readonly 'x-ratelimit-remaining': string;
  readonly 'x-ratelimit-reset': string;
  readonly 'retry-after'?: string | undefined;
  readonly 'x-ratelimit-degraded'?: string | undefined;
}

export interface RedisConnectionConfig {
  readonly host?: string | undefined;
  readonly port?: number | undefined;
  readonly password?: string | undefined;
  readonly db?: number | undefined;
  readonly tls?: boolean | undefined;
  readonly connectTimeoutMs?: number | undefined;
  readonly commandTimeoutMs?: number | undefined;
  readonly keyPrefix?: string | undefined;
  readonly maxRetriesPerRequest?: number | undefined;
  readonly enableReadyCheck?: boolean | undefined;
}

export interface RateLimiterOptions {
  readonly failurePolicy?: RateLimitFailurePolicy | undefined;
  readonly defaultWindowSec?: number | undefined;
  readonly defaultLimit?: number | undefined;
  readonly keyPrefix?: string | undefined;
}
