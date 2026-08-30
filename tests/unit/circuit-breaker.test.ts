import { describe, it, expect, vi } from 'vitest';
import { CircuitBreaker } from '../../src/circuit-breaker/circuit-breaker.js';
import type { CircuitBreakerConfig } from '../../src/circuit-breaker/types.js';

describe('CircuitBreaker State Machine & Transitions', () => {
  const config: CircuitBreakerConfig = {
    enabled: true,
    failureThreshold: 3,
    resetTimeoutMs: 100, // Short reset for testing
    halfOpenMaxRequests: 1,
    failureStatusCodes: [502, 503, 504],
  };

  it('should start in CLOSED state and allow requests', () => {
    const cb = new CircuitBreaker('http://localhost:4001', config);
    expect(cb.state).toBe('CLOSED');

    const decision = cb.beforeRequest();
    expect(decision.allowed).toBe(true);
    expect(decision.state).toBe('CLOSED');
  });

  it('should remain CLOSED when failures are below threshold', () => {
    const cb = new CircuitBreaker('http://localhost:4001', config);
    cb.onFailure(502);
    cb.onFailure(503);
    expect(cb.state).toBe('CLOSED');
    expect(cb.getStats().failureCount).toBe(2);
  });

  it('should not count 2xx, 3xx, 4xx as failures', () => {
    const cb = new CircuitBreaker('http://localhost:4001', config);
    cb.onFailure(200);
    cb.onFailure(400);
    cb.onFailure(401);
    cb.onFailure(404);
    expect(cb.getStats().failureCount).toBe(0);
    expect(cb.state).toBe('CLOSED');
  });

  it('should transition to OPEN when failureThreshold is reached', () => {
    const stateChangeSpy = vi.fn();
    const cb = new CircuitBreaker('http://localhost:4001', config, stateChangeSpy);

    cb.onFailure(502);
    cb.onFailure(503);
    cb.onFailure(504);

    expect(cb.state).toBe('OPEN');
    expect(stateChangeSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        previousState: 'CLOSED',
        newState: 'OPEN',
        origin: 'http://localhost:4001',
      })
    );

    const decision = cb.beforeRequest();
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.state).toBe('OPEN');
      expect(decision.retryAfterSec).toBeGreaterThan(0);
      expect(decision.reason).toBe('UPSTREAM_CIRCUIT_OPEN');
    }
  });

  it('should transition from OPEN to HALF_OPEN after cooldown reset timeout', async () => {
    const cb = new CircuitBreaker('http://localhost:4001', config);
    cb.onFailure(502);
    cb.onFailure(502);
    cb.onFailure(502);
    expect(cb.state).toBe('OPEN');

    // Wait for resetTimeoutMs
    await new Promise((resolve) => setTimeout(resolve, 110));

    const decision = cb.beforeRequest();
    expect(decision.allowed).toBe(true);
    if (decision.allowed) {
      expect(decision.state).toBe('HALF_OPEN');
      expect(decision.isProbe).toBe(true);
    }
    expect(cb.state).toBe('HALF_OPEN');
  });

  it('should transition from HALF_OPEN back to CLOSED on successful probe', async () => {
    const cb = new CircuitBreaker('http://localhost:4001', config);
    cb.onFailure(502);
    cb.onFailure(502);
    cb.onFailure(502);

    await new Promise((resolve) => setTimeout(resolve, 110));

    const probe = cb.beforeRequest();
    expect(probe.allowed).toBe(true);
    if (probe.allowed) {
      expect(probe.state).toBe('HALF_OPEN');
      expect(probe.isProbe).toBe(true);
    }

    cb.onSuccess();
    expect(cb.state).toBe('CLOSED');
    expect(cb.getStats().failureCount).toBe(0);
  });

  it('should transition from HALF_OPEN back to OPEN on failed probe', async () => {
    const cb = new CircuitBreaker('http://localhost:4001', config);
    cb.onFailure(502);
    cb.onFailure(502);
    cb.onFailure(502);

    await new Promise((resolve) => setTimeout(resolve, 110));

    const probe = cb.beforeRequest();
    expect(probe.allowed).toBe(true);

    cb.onFailure(502);
    expect(cb.state).toBe('OPEN');
  });

  it('should block additional requests during HALF_OPEN probing', async () => {
    const cb = new CircuitBreaker('http://localhost:4001', config);
    cb.onFailure(502);
    cb.onFailure(502);
    cb.onFailure(502);

    await new Promise((resolve) => setTimeout(resolve, 110));

    // First request is accepted as probe
    const probe = cb.beforeRequest();
    expect(probe.allowed).toBe(true);

    // Second request while probe is active should be rejected
    const secondReq = cb.beforeRequest();
    expect(secondReq.allowed).toBe(false);
    if (!secondReq.allowed) {
      expect(secondReq.reason).toBe('UPSTREAM_CIRCUIT_HALF_OPEN_PROBING');
    }
  });
});
