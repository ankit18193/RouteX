import { Pool } from 'undici';
import type { UpstreamPoolOptions } from './types.js';

export class UpstreamPoolManager {
  private readonly pools = new Map<string, Pool>();
  private isClosed = false;

  constructor(private readonly defaultOptions: UpstreamPoolOptions = {}) {}

  /**
   * Obtain or initialize an Undici connection pool for an upstream origin.
   * @param targetUrl Full upstream target URL (e.g. 'http://localhost:4001/api/v1/users')
   * @param overrideOptions Optional per-route connection options
   */
  public getPool(targetUrl: string, overrideOptions?: UpstreamPoolOptions): Pool {
    if (this.isClosed) {
      throw new Error('Cannot acquire upstream connection pool: UpstreamPoolManager is closed');
    }

    const origin = new URL(targetUrl).origin;
    let pool = this.pools.get(origin);

    if (!pool) {
      const connections = overrideOptions?.connections ?? this.defaultOptions.connections ?? 100;
      const pipelining = overrideOptions?.pipelining ?? this.defaultOptions.pipelining ?? 1;
      const keepAliveTimeout = overrideOptions?.keepAliveTimeout ?? this.defaultOptions.keepAliveTimeout ?? 60000;
      const keepAliveMaxTimeout = overrideOptions?.keepAliveMaxTimeout ?? this.defaultOptions.keepAliveMaxTimeout ?? 600000;
      const connectTimeoutMs = overrideOptions?.connectTimeoutMs ?? this.defaultOptions.connectTimeoutMs ?? 5000;
      const headersTimeoutMs = overrideOptions?.headersTimeoutMs ?? this.defaultOptions.headersTimeoutMs ?? 30000;
      const bodyTimeoutMs = overrideOptions?.bodyTimeoutMs ?? this.defaultOptions.bodyTimeoutMs ?? 30000;

      pool = new Pool(origin, {
        connections,
        pipelining,
        keepAliveTimeout,
        keepAliveMaxTimeout,
        connectTimeout: connectTimeoutMs,
        headersTimeout: headersTimeoutMs,
        bodyTimeout: bodyTimeoutMs,
      });

      this.pools.set(origin, pool);
    }

    return pool;
  }

  /**
   * Gracefully close all connection pools and drain active connections.
   */
  public async close(): Promise<void> {
    if (this.isClosed) {
      return;
    }
    this.isClosed = true;

    const closePromises = Array.from(this.pools.values()).map((p) => p.close());
    await Promise.all(closePromises);
    this.pools.clear();
  }

  /**
   * Forcefully destroy all connection pools immediately.
   */
  public async destroy(): Promise<void> {
    this.isClosed = true;
    const destroyPromises = Array.from(this.pools.values()).map((p) => p.destroy());
    await Promise.all(destroyPromises);
    this.pools.clear();
  }

  /**
   * Get count of active origin pools.
   */
  public get poolCount(): number {
    return this.pools.size;
  }
}
