import type { LatencyBreakdown } from '../types/index.js';

export interface HighResolutionTimer {
  /**
   * Stop the timer and return the total elapsed time in milliseconds.
   */
  readonly stop: () => number;
  /**
   * Read the current elapsed time in milliseconds without stopping the timer.
   */
  readonly elapsedMs: () => number;
  /**
   * The start timestamp in nanoseconds from process.hrtime.bigint().
   */
  readonly startNs: bigint;
}

/**
 * Start a high-resolution timer using process.hrtime.bigint()
 */
export function startTimer(): HighResolutionTimer {
  const startNs = process.hrtime.bigint();

  const elapsedMs = (): number => {
    return elapsedMsFrom(startNs);
  };

  const stop = (): number => {
    return elapsedMs();
  };

  return {
    startNs,
    elapsedMs,
    stop,
  };
}

/**
 * Calculate elapsed milliseconds from a starting process.hrtime.bigint() timestamp.
 */
export function elapsedMsFrom(startNs: bigint): number {
  const currentNs = process.hrtime.bigint();
  const diffNs = currentNs - startNs;
  return roundPrecision(Number(diffNs) / 1_000_000, 3);
}

/**
 * Calculate the latency breakdown separating upstream latency from gateway overhead.
 */
export function calculateLatencyBreakdown(params: {
  readonly totalDurationMs: number;
  readonly upstreamLatencyMs: number;
}): LatencyBreakdown {
  const totalDurationMs = roundPrecision(Math.max(0, params.totalDurationMs), 3);
  const upstreamLatencyMs = roundPrecision(Math.max(0, params.upstreamLatencyMs), 3);
  const gatewayOverheadMs = roundPrecision(
    Math.max(0, totalDurationMs - upstreamLatencyMs),
    3
  );

  return {
    totalDurationMs,
    upstreamLatencyMs,
    gatewayOverheadMs,
  };
}

/**
 * Helper to round a number to fixed decimal precision
 */
export function roundPrecision(value: number, decimals = 3): number {
  const factor = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

/**
 * Format duration in milliseconds for human-readable logs
 */
export function formatDurationMs(ms: number): string {
  if (ms < 1) {
    return `${roundPrecision(ms * 1000, 1)}µs`;
  }
  if (ms >= 1000) {
    return `${roundPrecision(ms / 1000, 2)}s`;
  }
  return `${roundPrecision(ms, 2)}ms`;
}
