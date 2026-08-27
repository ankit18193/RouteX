import { describe, it, expect } from 'vitest';
import {
  startTimer,
  calculateLatencyBreakdown,
  roundPrecision,
  formatDurationMs,
} from '../../src/utils/timing.js';

describe('High-Resolution Latency Timing', () => {
  it('should measure elapsed time accurately with startTimer', async () => {
    const timer = startTimer();
    expect(timer.startNs).toBeTypeOf('bigint');

    // Wait 20ms
    await new Promise((resolve) => setTimeout(resolve, 20));

    const elapsed = timer.elapsedMs();
    expect(elapsed).toBeGreaterThanOrEqual(15);
    expect(elapsed).toBeLessThan(100);

    const stopped = timer.stop();
    expect(stopped).toBeGreaterThanOrEqual(elapsed);
  });

  it('should calculate latency breakdown correctly', () => {
    const breakdown = calculateLatencyBreakdown({
      totalDurationMs: 45.678,
      upstreamLatencyMs: 42.123,
    });

    expect(breakdown.totalDurationMs).toBe(45.678);
    expect(breakdown.upstreamLatencyMs).toBe(42.123);
    expect(breakdown.gatewayOverheadMs).toBe(3.555);
  });

  it('should clamp negative values and handle zero latencies safely', () => {
    const breakdown = calculateLatencyBreakdown({
      totalDurationMs: 10.0,
      upstreamLatencyMs: 12.0, // Upstream clock jitter edge case
    });

    expect(breakdown.totalDurationMs).toBe(10.0);
    expect(breakdown.upstreamLatencyMs).toBe(12.0);
    expect(breakdown.gatewayOverheadMs).toBe(0);
  });

  it('should round numbers with precision correctly', () => {
    expect(roundPrecision(12.34567, 3)).toBe(12.346);
    expect(roundPrecision(12.3451, 3)).toBe(12.345);
    expect(roundPrecision(10, 2)).toBe(10);
  });

  it('should format durations into human readable strings', () => {
    expect(formatDurationMs(0.456)).toBe('456µs');
    expect(formatDurationMs(12.34)).toBe('12.34ms');
    expect(formatDurationMs(1250)).toBe('1.25s');
  });
});
