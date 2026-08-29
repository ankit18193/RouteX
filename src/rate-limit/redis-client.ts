import { Redis, type RedisOptions } from 'ioredis';
import type { RedisConnectionConfig } from './types.js';

export type RedisClientState = 'connecting' | 'ready' | 'reconnecting' | 'disconnecting' | 'closed';

export class RedisClient {
  private readonly client: Redis;
  private isClosed = false;
  private readonly commandTimeoutMs: number;

  constructor(config: RedisConnectionConfig = {}) {
    const host = config.host ?? 'localhost';
    const port = config.port ?? 6379;
    this.commandTimeoutMs = config.commandTimeoutMs ?? 2000;

    const redisOptions: RedisOptions = {
      host,
      port,
      password: config.password || undefined,
      db: config.db ?? 0,
      tls: config.tls ? {} : undefined,
      connectTimeout: config.connectTimeoutMs ?? 3000,
      commandTimeout: this.commandTimeoutMs,
      keyPrefix: config.keyPrefix || undefined,
      maxRetriesPerRequest: config.maxRetriesPerRequest ?? 2,
      enableReadyCheck: config.enableReadyCheck ?? true,
      lazyConnect: true,
      retryStrategy: (times) => {
        if (this.isClosed) return null;
        // Bounded exponential backoff: 50ms, 100ms, 200ms... up to 2000ms
        const delay = Math.min(times * 50, 2000);
        return delay;
      },
    };

    this.client = new Redis(redisOptions);

    // Suppress unhandled error crashes while logging status
    this.client.on('error', (_err) => {
      // Error is captured by calling commands; listener prevents uncaughtException
    });
  }

  /**
   * Connect to Redis server.
   */
  public async connect(): Promise<void> {
    if (this.isClosed) {
      throw new Error('Cannot connect closed Redis client');
    }
    if (this.client.status === 'ready' || this.client.status === 'connecting') {
      return;
    }
    await this.client.connect();
  }

  /**
   * Check if Redis connection is active and ready.
   */
  public isReady(): boolean {
    return !this.isClosed && this.client.status === 'ready';
  }

  /**
   * Current connection status.
   */
  public get status(): string {
    return this.client.status;
  }

  /**
   * Ping Redis server.
   */
  public async ping(): Promise<string> {
    return this.client.ping();
  }

  /**
   * Load Lua script into Redis script cache and return SHA1 digest.
   */
  public async loadScript(script: string): Promise<string> {
    const result = await this.client.script('LOAD', script);
    return String(result);
  }

  /**
   * Execute Lua script using cached SHA1 digest (EVALSHA).
   */
  public async evalSha(sha: string, keys: string[], args: (string | number)[]): Promise<unknown> {
    return this.client.evalsha(sha, keys.length, ...keys, ...args);
  }

  /**
   * Execute Lua script directly with raw script text (EVAL).
   */
  public async eval(script: string, keys: string[], args: (string | number)[]): Promise<unknown> {
    return this.client.eval(script, keys.length, ...keys, ...args);
  }

  /**
   * Get underlying raw ioredis instance.
   */
  public get rawClient(): Redis {
    return this.client;
  }

  /**
   * Close connection and release resources.
   */
  public async close(): Promise<void> {
    this.isClosed = true;
    try {
      if (this.client.status === 'ready' || this.client.status === 'connecting') {
        await this.client.quit();
      } else {
        this.client.disconnect();
      }
    } catch {
      this.client.disconnect();
    }
  }
}

/**
 * Factory to create managed RedisClient.
 */
export function createRedisClient(config: RedisConnectionConfig = {}): RedisClient {
  return new RedisClient(config);
}
