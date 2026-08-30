import type { RouteCircuitBreakerPolicy } from '../types/index.js';

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CircuitBreakerConfig extends RouteCircuitBreakerPolicy {}

export interface CircuitBreakerStats {
  readonly state: CircuitState;
  readonly failureCount: number;
  readonly consecutiveSuccesses: number;
  readonly lastFailureTime: number | null;
  readonly nextAttemptTime: number | null;
  readonly activeProbes: number;
}

export type CircuitBreakerDecision =
  | {
      readonly allowed: true;
      readonly state: CircuitState;
      readonly isProbe?: boolean | undefined;
    }
  | {
      readonly allowed: false;
      readonly state: 'OPEN';
      readonly retryAfterSec: number;
      readonly reason: string;
    };

export interface CircuitStateChangeEvent {
  readonly origin: string;
  readonly previousState: CircuitState;
  readonly newState: CircuitState;
  readonly failureCount: number;
  readonly timestamp: number;
}
