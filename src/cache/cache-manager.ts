import type { FastifyRequest } from 'fastify';
import type { RouteDefinition, RouteCachePolicy } from '../types/index.js';
import type { AuthContext } from '../auth/types.js';
import { RedisCacheStore } from './cache-store.js';
import type { RedisClient } from '../rate-limit/redis-client.js';
import { generateCacheKey } from './cache-key.js';
import {
  isRequestCacheable,
  isResponseCacheable,
  sanitizeCacheHeaders,
} from './cache-policy.js';
import { SingleFlightGroup } from './single-flight.js';
import type { CacheEntry, CacheLookupResult } from './types.js';

export interface CacheManagerOptions {
  readonly redisClient?: RedisClient | undefined;
  readonly keyPrefix?: string | undefined;
}

export class CacheManager {
  private readonly cacheStoreInstance: RedisCacheStore | null = null;
  private readonly singleFlightGroup = new SingleFlightGroup();
  private readonly keyPrefix: string;

  constructor(redisClient?: RedisClient, options: CacheManagerOptions = {}) {
    this.keyPrefix = options.keyPrefix ?? 'routex:';
    if (redisClient) {
      this.cacheStoreInstance = new RedisCacheStore(redisClient);
    }
  }

  /**
   * Evaluates request cacheability and performs cache lookup.
   */
  public async lookup(
    req: FastifyRequest,
    route: RouteDefinition,
    authContext?: AuthContext
  ): Promise<CacheLookupResult> {
    if (!this.cacheStoreInstance) {
      return { status: 'BYPASS' };
    }

    const cacheability = isRequestCacheable(route, req.method, req.headers, authContext);
    if (!cacheability.cacheable) {
      return { status: 'BYPASS' };
    }

    const urlPath = req.url.split('?')[0] ?? '/';
    const search = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';

    const identityId = authContext?.authenticated
      ? (authContext.userId ?? authContext.keyId ?? undefined)
      : undefined;

    const { cacheKey } = generateCacheKey({
      keyPrefix: this.keyPrefix,
      routeId: route.id,
      method: req.method,
      pathname: urlPath,
      search,
      headers: req.headers,
      varyBy: route.cache?.varyBy,
      identityId,
    });

    const entry = await this.cacheStoreInstance.get(cacheKey);
    if (!entry) {
      return {
        status: 'MISS',
        cacheKey,
        policy: route.cache,
      };
    }

    const ageSec = Math.max(0, Math.floor((Date.now() - entry.createdAt) / 1000));
    return {
      status: 'HIT',
      entry,
      ageSec,
      cacheKey,
    };
  }

  /**
   * Stores a cacheable response in Redis.
   */
  public async store(
    cacheKey: string,
    statusCode: number,
    headers: Record<string, string | string[] | undefined>,
    body: Buffer | string,
    policy?: RouteCachePolicy
  ): Promise<boolean> {
    if (!this.cacheStoreInstance || !policy || !policy.enabled) {
      return false;
    }

    const bodyBuffer = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf-8');
    const bodyLengthBytes = bodyBuffer.length;

    const cacheability = isResponseCacheable(statusCode, headers, bodyLengthBytes, policy);
    if (!cacheability.cacheable) {
      return false;
    }

    const sanitizedHeaders = sanitizeCacheHeaders(headers);
    const now = Date.now();
    const entry: CacheEntry = {
      statusCode,
      headers: sanitizedHeaders,
      body: bodyBuffer.toString('utf-8'),
      createdAt: now,
      expiresAt: now + cacheability.ttlSec * 1000,
    };

    return this.cacheStoreInstance.set(cacheKey, entry, cacheability.ttlSec);
  }

  /**
   * Execute an upstream operation with single-flight stampede protection.
   */
  public executeSingleFlight<T>(key: string, fn: () => Promise<T>): Promise<T> {
    return this.singleFlightGroup.execute(key, fn);
  }

  /**
   * Underlying single-flight group instance.
   */
  public get singleFlight(): SingleFlightGroup {
    return this.singleFlightGroup;
  }

  /**
   * Underlying Redis store.
   */
  public get cacheStore(): RedisCacheStore | null {
    return this.cacheStoreInstance;
  }
}
