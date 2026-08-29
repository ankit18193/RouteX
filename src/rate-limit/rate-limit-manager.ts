import type { RouteDefinition } from '../types/index.js';
import type { AuthContext } from '../auth/types.js';
import type {
  RateLimitHeaders,
  RateLimitResult,
  RedisConnectionConfig,
} from './types.js';
import { createRedisClient, RedisClient } from './redis-client.js';
import {
  createSlidingWindowRateLimiter,
  SlidingWindowRateLimiter,
} from './sliding-window-limiter.js';

export interface RateLimitManagerOptions {
  readonly redisClient?: RedisClient | undefined;
  readonly keyPrefix?: string | undefined;
}

export class RateLimitManager {
  private readonly redis: RedisClient;
  private readonly limiter: SlidingWindowRateLimiter;
  private readonly ownsRedis: boolean;

  constructor(
    config: RedisConnectionConfig = {},
    options: RateLimitManagerOptions = {}
  ) {
    if (options.redisClient) {
      this.redis = options.redisClient;
      this.ownsRedis = false;
    } else {
      this.redis = createRedisClient(config);
      this.ownsRedis = true;
    }

    this.limiter = createSlidingWindowRateLimiter(this.redis, {
      keyPrefix: options.keyPrefix ?? config.keyPrefix ?? 'routex:',
      failurePolicy: 'fail-open',
    });
  }

  /**
   * Initialize Redis connection and Lua script cache.
   */
  public async init(): Promise<void> {
    if (this.ownsRedis) {
      try {
        await this.redis.connect();
      } catch {
        // Handled through fail-open policy on runtime checks
      }
    }
    await this.limiter.init();
  }

  /**
   * Check Tier-1 IP rate limit protection (executed prior to authentication).
   */
  public async checkIpRateLimit(
    clientIp: string,
    route: RouteDefinition,
    nowMs?: number
  ): Promise<RateLimitResult | null> {
    if (!route.rateLimit || !route.rateLimit.enabled) {
      return null;
    }

    const windowSec = route.rateLimit.windowSec;
    const limit = route.rateLimit.ipLimit ?? route.rateLimit.limit;

    return this.limiter.checkLimit({
      namespace: 'ip',
      identifier: clientIp,
      routeId: route.id,
      windowSec,
      limit,
      nowMs,
    });
  }

  /**
   * Check Tier-2 authenticated identity rate limit (executed post authentication).
   */
  public async checkIdentityRateLimit(
    authContext: AuthContext,
    route: RouteDefinition,
    nowMs?: number
  ): Promise<RateLimitResult | null> {
    if (!route.rateLimit || !route.rateLimit.enabled || !authContext.authenticated) {
      return null;
    }

    const windowSec = route.rateLimit.windowSec;

    // 1. Resolve Tier Limit (with fallback to base route limit)
    let limit = route.rateLimit.limit;
    if (
      authContext.tier &&
      route.rateLimit.tiers &&
      typeof route.rateLimit.tiers[authContext.tier] === 'number'
    ) {
      limit = route.rateLimit.tiers[authContext.tier]!;
    }

    // 2. Resolve namespace & identifier
    if (authContext.authType === 'api-key') {
      const identifier = authContext.keyId ?? authContext.userId ?? 'key_client';
      return this.limiter.checkLimit({
        namespace: 'key',
        identifier,
        routeId: route.id,
        windowSec,
        limit,
        nowMs,
      });
    }

    const identifier = authContext.userId ?? 'usr_client';
    return this.limiter.checkLimit({
      namespace: 'user',
      identifier,
      routeId: route.id,
      windowSec,
      limit,
      nowMs,
    });
  }

  /**
   * Format standard HTTP response rate limit headers.
   */
  public formatHeaders(result: RateLimitResult): RateLimitHeaders {
    const headers: RateLimitHeaders = {
      'x-ratelimit-limit': String(result.limit),
      'x-ratelimit-remaining': String(result.remaining),
      'x-ratelimit-reset': String(result.resetAt),
    };

    if (result.retryAfterSec > 0) {
      (headers as any)['retry-after'] = String(result.retryAfterSec);
    }

    if (result.degraded) {
      (headers as any)['x-ratelimit-degraded'] = '1';
    }

    return headers;
  }

  /**
   * Close Redis connection.
   */
  public async close(): Promise<void> {
    if (this.ownsRedis) {
      await this.redis.close();
    }
  }

  /**
   * Underlying limiter.
   */
  public get rateLimiter(): SlidingWindowRateLimiter {
    return this.limiter;
  }

  /**
   * Underlying Redis client.
   */
  public get redisClient(): RedisClient {
    return this.redis;
  }
}

/**
 * Factory to create RateLimitManager.
 */
export function createRateLimitManager(
  config?: RedisConnectionConfig,
  options?: RateLimitManagerOptions
): RateLimitManager {
  return new RateLimitManager(config, options);
}
