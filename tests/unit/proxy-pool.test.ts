import { describe, it, expect } from 'vitest';
import { UpstreamPoolManager } from '../../src/proxy/pool.js';

describe('UpstreamPoolManager', () => {
  it('should initialize and cache pools per origin', async () => {
    const manager = new UpstreamPoolManager({
      connections: 20,
      keepAliveTimeout: 10000,
    });

    const pool1 = manager.getPool('http://localhost:4001/api/v1/users');
    const pool2 = manager.getPool('http://localhost:4001/api/v1/users/me');
    const pool3 = manager.getPool('http://localhost:4002/api/v1/chats');

    // Same origin should reuse the same pool instance
    expect(pool1).toBe(pool2);
    // Different origin creates new pool
    expect(pool1).not.toBe(pool3);
    expect(manager.poolCount).toBe(2);

    await manager.close();
    expect(manager.poolCount).toBe(0);
  });

  it('should throw error when acquiring pool after manager is closed', async () => {
    const manager = new UpstreamPoolManager();
    await manager.close();

    expect(() => manager.getPool('http://localhost:4001')).toThrow(
      /Cannot acquire upstream connection pool/
    );
  });

  it('should destroy pools gracefully without throwing', async () => {
    const manager = new UpstreamPoolManager();
    manager.getPool('http://localhost:4001');
    manager.getPool('http://localhost:4002');

    await expect(manager.destroy()).resolves.toBeUndefined();
    expect(manager.poolCount).toBe(0);
  });
});
