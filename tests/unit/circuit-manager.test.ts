import { describe, it, expect, vi } from 'vitest';
import { CircuitManager } from '../../src/circuit-breaker/circuit-manager.js';

describe('CircuitManager Origin Isolation', () => {
  it('should isolate circuit state per upstream origin', () => {
    const changeSpy = vi.fn();
    const manager = new CircuitManager({ onStateChange: changeSpy });

    const breakerUser = manager.getBreaker('http://localhost:4001/api/v1/users', {
      enabled: true,
      failureThreshold: 2,
      resetTimeoutMs: 5000,
      halfOpenMaxRequests: 1,
      failureStatusCodes: [502, 503, 504],
    });

    const breakerChat = manager.getBreaker('http://localhost:4002/api/v1/chats', {
      enabled: true,
      failureThreshold: 2,
      resetTimeoutMs: 5000,
      halfOpenMaxRequests: 1,
      failureStatusCodes: [502, 503, 504],
    });

    expect(breakerUser.origin).toBe('http://localhost:4001');
    expect(breakerChat.origin).toBe('http://localhost:4002');

    // Fail User service twice -> opens User circuit
    breakerUser.onFailure(502);
    breakerUser.onFailure(502);

    expect(breakerUser.state).toBe('OPEN');
    expect(breakerUser.beforeRequest().allowed).toBe(false);

    // Chat service circuit must remain CLOSED
    expect(breakerChat.state).toBe('CLOSED');
    expect(breakerChat.beforeRequest().allowed).toBe(true);
  });

  it('should reuse existing breaker instance for identical origin', () => {
    const manager = new CircuitManager();
    const b1 = manager.getBreaker('http://localhost:4001/items/1');
    const b2 = manager.getBreaker('http://localhost:4001/items/2');
    expect(b1).toBe(b2);
  });

  it('should reset all tracked breakers on resetAll()', () => {
    const manager = new CircuitManager();
    const b1 = manager.getBreaker('http://localhost:4001');
    b1.onFailure(502);
    expect(b1.getStats().failureCount).toBe(1);

    manager.resetAll();
    expect(manager.origins.length).toBe(0);
  });
});
