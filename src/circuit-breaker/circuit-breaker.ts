import type {
  CircuitBreakerConfig,
  CircuitBreakerDecision,
  CircuitBreakerStats,
  CircuitState,
  CircuitStateChangeEvent,
} from './types.js';
import type { StateChangeCallback } from './circuit-state.js';

export class CircuitBreaker {
  public readonly origin: string;
  private config: CircuitBreakerConfig;
  private readonly onStateChange?: StateChangeCallback | undefined;

  private currentState: CircuitState = 'CLOSED';
  private failureCount = 0;
  private consecutiveSuccesses = 0;
  private lastFailureTime: number | null = null;
  private nextAttemptTime: number | null = null;
  private activeProbes = 0;

  constructor(
    origin: string,
    config: CircuitBreakerConfig,
    onStateChange?: StateChangeCallback
  ) {
    this.origin = origin;
    this.config = config;
    this.onStateChange = onStateChange;
  }

  public updateConfig(config: CircuitBreakerConfig): void {
    this.config = config;
  }

  /**
   * Evaluates circuit state before dispatching request to upstream.
   */
  public beforeRequest(): CircuitBreakerDecision {
    if (!this.config.enabled) {
      return { allowed: true, state: 'CLOSED' };
    }

    const now = Date.now();

    if (this.currentState === 'CLOSED') {
      return { allowed: true, state: 'CLOSED' };
    }

    if (this.currentState === 'OPEN') {
      if (this.nextAttemptTime !== null && now >= this.nextAttemptTime) {
        // Transition to HALF_OPEN
        this.transitionTo('HALF_OPEN');
        this.activeProbes = 1;
        return { allowed: true, state: 'HALF_OPEN', isProbe: true };
      }

      const retryAfterSec = this.nextAttemptTime
        ? Math.max(1, Math.ceil((this.nextAttemptTime - now) / 1000))
        : Math.ceil(this.config.resetTimeoutMs / 1000);

      return {
        allowed: false,
        state: 'OPEN',
        retryAfterSec,
        reason: 'UPSTREAM_CIRCUIT_OPEN',
      };
    }

    // currentState === 'HALF_OPEN'
    if (this.activeProbes < this.config.halfOpenMaxRequests) {
      this.activeProbes++;
      return { allowed: true, state: 'HALF_OPEN', isProbe: true };
    }

    const retryAfterSec = this.nextAttemptTime
      ? Math.max(1, Math.ceil((this.nextAttemptTime - now) / 1000))
      : Math.ceil(this.config.resetTimeoutMs / 1000);

    return {
      allowed: false,
      state: 'OPEN',
      retryAfterSec,
      reason: 'UPSTREAM_CIRCUIT_HALF_OPEN_PROBING',
    };
  }

  /**
   * Records a successful upstream response.
   */
  public onSuccess(): void {
    if (!this.config.enabled) {
      return;
    }

    if (this.currentState === 'HALF_OPEN') {
      this.consecutiveSuccesses++;
      if (this.consecutiveSuccesses >= this.config.halfOpenMaxRequests) {
        this.transitionTo('CLOSED');
      }
    } else if (this.currentState === 'CLOSED') {
      this.failureCount = 0;
    }
  }

  /**
   * Records a failed upstream request or response.
   */
  public onFailure(errOrStatus?: Error | number): void {
    if (!this.config.enabled) {
      return;
    }

    if (!this.isFailure(errOrStatus)) {
      return;
    }

    const now = Date.now();
    this.lastFailureTime = now;

    if (this.currentState === 'HALF_OPEN') {
      this.nextAttemptTime = now + this.config.resetTimeoutMs;
      this.transitionTo('OPEN');
    } else if (this.currentState === 'CLOSED') {
      this.failureCount++;
      if (this.failureCount >= this.config.failureThreshold) {
        this.nextAttemptTime = now + this.config.resetTimeoutMs;
        this.transitionTo('OPEN');
      }
    }
  }

  /**
   * Determines if a status code or Error qualifies as an upstream circuit failure.
   */
  public isFailure(errOrStatus?: Error | number): boolean {
    if (typeof errOrStatus === 'number') {
      return this.config.failureStatusCodes.includes(errOrStatus);
    }

    if (errOrStatus instanceof Error) {
      // System errors, timeouts, connection resets, connection refused are failures
      const msg = errOrStatus.message.toLowerCase();
      const code = (errOrStatus as any).code;

      if (
        code === 'ECONNREFUSED' ||
        code === 'ECONNRESET' ||
        code === 'ETIMEDOUT' ||
        code === 'UND_ERR_CONNECT_TIMEOUT' ||
        code === 'UND_ERR_SOCKET' ||
        msg.includes('timed out') ||
        msg.includes('timeout') ||
        msg.includes('connection refused') ||
        msg.includes('socket hang up') ||
        msg.includes('gateway timeout')
      ) {
        return true;
      }
      return true;
    }

    return false;
  }

  /**
   * Perform state transition and emit change event.
   */
  private transitionTo(newState: CircuitState): void {
    const previousState = this.currentState;
    if (previousState === newState) {
      return;
    }

    this.currentState = newState;

    if (newState === 'CLOSED') {
      this.failureCount = 0;
      this.consecutiveSuccesses = 0;
      this.activeProbes = 0;
      this.nextAttemptTime = null;
    } else if (newState === 'HALF_OPEN') {
      this.activeProbes = 0;
      this.consecutiveSuccesses = 0;
    } else if (newState === 'OPEN') {
      this.activeProbes = 0;
      this.consecutiveSuccesses = 0;
    }

    if (this.onStateChange) {
      const event: CircuitStateChangeEvent = {
        origin: this.origin,
        previousState,
        newState,
        failureCount: this.failureCount,
        timestamp: Date.now(),
      };
      this.onStateChange(event);
    }
  }

  /**
   * Reset circuit breaker to initial CLOSED state.
   */
  public reset(): void {
    this.currentState = 'CLOSED';
    this.failureCount = 0;
    this.consecutiveSuccesses = 0;
    this.lastFailureTime = null;
    this.nextAttemptTime = null;
    this.activeProbes = 0;
  }

  /**
   * Retrieve statistical summary for telemetry.
   */
  public getStats(): CircuitBreakerStats {
    return {
      state: this.currentState,
      failureCount: this.failureCount,
      consecutiveSuccesses: this.consecutiveSuccesses,
      lastFailureTime: this.lastFailureTime,
      nextAttemptTime: this.nextAttemptTime,
      activeProbes: this.activeProbes,
    };
  }

  public get state(): CircuitState {
    return this.currentState;
  }
}
