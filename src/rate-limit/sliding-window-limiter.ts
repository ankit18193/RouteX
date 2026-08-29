import { generateRequestId } from '../utils/uuid.js';
import { generateRateLimitKey } from './key-generator.js';
import {
  SLIDING_WINDOW_LUA_SCRIPT,
  SLIDING_WINDOW_LUA_SHA,
  decodeLuaResult,
} from './lua-scripts.js';
import type { RedisClient } from './redis-client.js';
import type {
  RateLimitFailurePolicy,
  RateLimitRequest,
  RateLimitResult,
  RateLimiterOptions,
} from './types.js';
import { ServiceUnavailableError } from '../errors/gateway-error.js';

export class SlidingWindowRateLimiter {
  private readonly redis: RedisClient;
  private readonly failurePolicy: RateLimitFailurePolicy;
  private readonly keyPrefix: string;
  private scriptSha: string = SLIDING_WINDOW_LUA_SHA;

  constructor(redis: RedisClient, options: RateLimiterOptions = {}) {
    this.redis = redis;
    this.failurePolicy = options.failurePolicy ?? 'fail-open';
    this.keyPrefix = options.keyPrefix ?? '';
  }

  /**
   * Pre-load rate limiting Lua script into Redis script cache.
   */
  public async init(): Promise<void> {
    try {
      if (this.redis.isReady()) {
        this.scriptSha = await this.redis.loadScript(SLIDING_WINDOW_LUA_SCRIPT);
      }
    } catch {
      // Script will be loaded on demand via NOSCRIPT recovery if needed
    }
  }

  /**
   * Execute atomic sliding window rate limit evaluation.
   */
  public async checkLimit(request: RateLimitRequest): Promise<RateLimitResult> {
    const nowMs = request.nowMs ?? Date.now();
    const windowMs = request.windowSec * 1000;
    const memberToken = `${nowMs}_${generateRequestId().slice(0, 16)}`;
    const key = generateRateLimitKey(request, this.keyPrefix);

    try {
      let rawResult: unknown;
      try {
        rawResult = await this.redis.evalSha(
          this.scriptSha,
          [key],
          [windowMs, request.limit, nowMs, memberToken]
        );
      } catch (err: unknown) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        if (errorMsg.includes('NOSCRIPT')) {
          // Script missing from Redis script cache: load and retry EVALSHA
          this.scriptSha = await this.redis.loadScript(SLIDING_WINDOW_LUA_SCRIPT);
          rawResult = await this.redis.evalSha(
            this.scriptSha,
            [key],
            [windowMs, request.limit, nowMs, memberToken]
          );
        } else {
          throw err;
        }
      }

      return decodeLuaResult(rawResult);
    } catch (err: unknown) {
      if (this.failurePolicy === 'fail-open') {
        // Degraded mode: allow request to continue with warning flag
        return {
          allowed: true,
          limit: request.limit,
          remaining: request.limit,
          resetAt: Math.ceil((nowMs + windowMs) / 1000),
          retryAfterSec: 0,
          degraded: true,
        };
      }

      // Fail-closed policy: reject with 503 Service Unavailable
      throw new ServiceUnavailableError(
        'Rate limit service temporarily unavailable',
        undefined,
        5,
        {
          routeId: request.routeId,
          namespace: request.namespace,
        }
      );
    }
  }
}

/**
 * Factory to create SlidingWindowRateLimiter instance.
 */
export function createSlidingWindowRateLimiter(
  redis: RedisClient,
  options?: RateLimiterOptions
): SlidingWindowRateLimiter {
  return new SlidingWindowRateLimiter(redis, options);
}
