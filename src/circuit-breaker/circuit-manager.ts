import { CircuitBreaker } from './circuit-breaker.js';
import { extractOrigin, type StateChangeCallback } from './circuit-state.js';
import type { CircuitBreakerConfig } from './types.js';

export interface CircuitManagerOptions {
  readonly onStateChange?: StateChangeCallback | undefined;
}

const DEFAULT_CIRCUIT_CONFIG: CircuitBreakerConfig = {
  enabled: true,
  failureThreshold: 5,
  resetTimeoutMs: 10000,
  halfOpenMaxRequests: 1,
  failureStatusCodes: [502, 503, 504],
};

export class CircuitManager {
  private readonly breakers = new Map<string, CircuitBreaker>();
  private readonly onStateChange?: StateChangeCallback | undefined;

  constructor(options: CircuitManagerOptions = {}) {
    this.onStateChange = options.onStateChange;
  }

  /**
   * Get or create a CircuitBreaker instance for the target upstream origin.
   */
  public getBreaker(targetUrl: string, config?: CircuitBreakerConfig): CircuitBreaker {
    const origin = extractOrigin(targetUrl);
    let breaker = this.breakers.get(origin);

    if (!breaker) {
      breaker = new CircuitBreaker(
        origin,
        config ?? DEFAULT_CIRCUIT_CONFIG,
        this.onStateChange
      );
      this.breakers.set(origin, breaker);
    } else if (config) {
      breaker.updateConfig(config);
    }

    return breaker;
  }

  /**
   * Reset all tracked circuit breakers.
   */
  public resetAll(): void {
    for (const breaker of this.breakers.values()) {
      breaker.reset();
    }
    this.breakers.clear();
  }

  /**
   * Get all registered origins.
   */
  public get origins(): readonly string[] {
    return Array.from(this.breakers.keys());
  }
}
