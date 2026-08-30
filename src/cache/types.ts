import type { RouteCachePolicy } from '../types/index.js';

export type CacheStatus = 'HIT' | 'MISS' | 'BYPASS' | 'STORE_FAILED';

export interface CacheEntry {
  readonly statusCode: number;
  readonly headers: Record<string, string>;
  readonly body: string; // Serialized response body (UTF-8 or Base64)
  readonly isBase64?: boolean;
  readonly createdAt: number;
  readonly expiresAt: number;
}

export interface CachedResponse {
  readonly status: 'HIT';
  readonly entry: CacheEntry;
  readonly ageSec: number;
  readonly cacheKey: string;
}

export interface CacheMissResult {
  readonly status: 'MISS' | 'BYPASS';
  readonly cacheKey?: string | undefined;
  readonly policy?: RouteCachePolicy | undefined;
}

export type CacheLookupResult = CachedResponse | CacheMissResult;

export interface GenerateCacheKeyOptions {
  readonly keyPrefix?: string | undefined;
  readonly routeId: string;
  readonly method: string;
  readonly pathname: string;
  readonly search?: string | undefined;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly varyBy?: readonly string[] | undefined;
  readonly identityId?: string | undefined;
}

export interface GeneratedCacheKey {
  readonly cacheKey: string;
  readonly keyHash: string;
}
