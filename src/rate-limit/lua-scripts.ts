import { createHash } from 'node:crypto';
import type { RateLimitResult } from './types.js';

/**
 * Production-grade atomic Lua script for Redis Sliding Window Log rate limiter.
 * 
 * KEYS[1]: Rate limit key
 * ARGV[1]: window_ms (sliding window in milliseconds)
 * ARGV[2]: limit (maximum allowed requests)
 * ARGV[3]: now_ms (current timestamp in milliseconds)
 * ARGV[4]: member (unique request identifier)
 * 
 * Returns array: [allowed (0 or 1), remaining, reset_at_sec, limit, retry_after_sec]
 */
export const SLIDING_WINDOW_LUA_SCRIPT = `
local key = KEYS[1]
local window_ms = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
local now_ms = tonumber(ARGV[3])
local member = ARGV[4]

-- 1. Evict entries strictly older than the sliding window boundary (now_ms - window_ms)
local clear_before = now_ms - window_ms
redis.call('ZREMRANGEBYSCORE', key, '-inf', clear_before)

-- 2. Count current active requests in window
local current_count = redis.call('ZCARD', key)

-- 3. Evaluate admission limit atomically
if current_count < limit then
    -- Allowed: record current request timestamp in Sorted Set
    redis.call('ZADD', key, now_ms, member)

    -- Refresh key TTL to window + 5 second safety buffer
    local ttl_sec = math.ceil((window_ms + 5000) / 1000)
    redis.call('EXPIRE', key, ttl_sec)

    local remaining = limit - (current_count + 1)
    local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
    local oldest_ts = (oldest and #oldest >= 2) and tonumber(oldest[2]) or now_ms
    local reset_at = math.ceil((oldest_ts + window_ms) / 1000)

    return { 1, remaining, reset_at, limit, 0 }
else
    -- Rejected: do NOT record request in ZSET
    local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
    local oldest_ts = (oldest and #oldest >= 2) and tonumber(oldest[2]) or (now_ms - window_ms + 1000)
    local reset_at = math.ceil((oldest_ts + window_ms) / 1000)
    local retry_after = math.max(1, math.ceil((oldest_ts + window_ms - now_ms) / 1000))

    return { 0, 0, reset_at, limit, retry_after }
end
`.trim();

/**
 * Compute SHA1 hash of Lua script for Redis EVALSHA.
 */
export function computeScriptSha(script: string): string {
  return createHash('sha1').update(script).digest('hex');
}

export const SLIDING_WINDOW_LUA_SHA = computeScriptSha(SLIDING_WINDOW_LUA_SCRIPT);

/**
 * Strongly typed decoder to translate raw Redis Lua response tuple into RateLimitResult.
 */
export function decodeLuaResult(rawResult: unknown): RateLimitResult {
  if (!Array.isArray(rawResult) || rawResult.length < 5) {
    throw new Error(`Invalid Redis Lua rate limit response structure: ${JSON.stringify(rawResult)}`);
  }

  const [allowedRaw, remainingRaw, resetAtRaw, limitRaw, retryAfterRaw] = rawResult;

  const allowed = Number(allowedRaw) === 1;
  const remaining = Math.max(0, Number(remainingRaw));
  const resetAt = Math.max(0, Number(resetAtRaw));
  const limit = Math.max(1, Number(limitRaw));
  const retryAfterSec = Math.max(0, Number(retryAfterRaw));

  return {
    allowed,
    remaining,
    resetAt,
    limit,
    retryAfterSec,
  };
}
