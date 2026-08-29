import type { RouteDefinition } from '../types/index.js';

export interface RouteMatchSuccess {
  readonly matched: true;
  readonly route: RouteDefinition;
  readonly targetUrl: string;
  readonly remainingPath: string;
}

export interface RouteMatchFailure {
  readonly matched: false;
  readonly reason: 'NOT_FOUND' | 'METHOD_NOT_ALLOWED';
  readonly allowedMethods?: readonly string[] | undefined;
}

export type RouteMatchResult = RouteMatchSuccess | RouteMatchFailure;

export interface UpstreamPoolOptions {
  readonly connections?: number | undefined;
  readonly pipelining?: number | undefined;
  readonly keepAliveTimeout?: number | undefined;
  readonly keepAliveMaxTimeout?: number | undefined;
  readonly connectTimeoutMs?: number | undefined;
  readonly headersTimeoutMs?: number | undefined;
  readonly bodyTimeoutMs?: number | undefined;
}

export interface ProxyRequestContext {
  readonly requestId: string;
  readonly route: RouteDefinition;
  readonly targetUrl: string;
  readonly clientIp: string;
  readonly startTime: bigint;
}
