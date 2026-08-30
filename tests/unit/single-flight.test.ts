import { describe, it, expect, vi } from 'vitest';
import { SingleFlightGroup } from '../../src/cache/single-flight.js';

describe('SingleFlightGroup Stampede Protection', () => {
  it('should collapse concurrent calls for the same key into a single execution', async () => {
    const group = new SingleFlightGroup();
    const spyFn = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return { data: 'hello' };
    });

    const [res1, res2, res3] = await Promise.all([
      group.execute('key1', spyFn),
      group.execute('key1', spyFn),
      group.execute('key1', spyFn),
    ]);

    expect(res1).toEqual({ data: 'hello' });
    expect(res2).toEqual({ data: 'hello' });
    expect(res3).toEqual({ data: 'hello' });
    expect(spyFn).toHaveBeenCalledTimes(1);
    expect(group.size).toBe(0);
  });

  it('should execute distinct keys independently', async () => {
    const group = new SingleFlightGroup();
    const fn1 = vi.fn(async () => 'result1');
    const fn2 = vi.fn(async () => 'result2');

    const [r1, r2] = await Promise.all([
      group.execute('k1', fn1),
      group.execute('k2', fn2),
    ]);

    expect(r1).toBe('result1');
    expect(r2).toBe('result2');
    expect(fn1).toHaveBeenCalledTimes(1);
    expect(fn2).toHaveBeenCalledTimes(1);
    expect(group.size).toBe(0);
  });

  it('should propagate errors to all waiters and clean up in-flight state', async () => {
    const group = new SingleFlightGroup();
    const spyErrorFn = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      throw new Error('upstream failure');
    });

    const results = await Promise.allSettled([
      group.execute('err_key', spyErrorFn),
      group.execute('err_key', spyErrorFn),
    ]);

    expect(results[0].status).toBe('rejected');
    expect(results[1].status).toBe('rejected');
    expect(spyErrorFn).toHaveBeenCalledTimes(1);
    expect(group.size).toBe(0);

    // Subsequent request for the same key should run a fresh execution
    const retryFn = vi.fn(async () => 'recovered');
    const res = await group.execute('err_key', retryFn);
    expect(res).toBe('recovered');
    expect(retryFn).toHaveBeenCalledTimes(1);
  });
});
