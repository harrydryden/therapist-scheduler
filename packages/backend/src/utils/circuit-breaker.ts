/**
 * Circuit Breaker Pattern Implementation
 *
 * Prevents cascading failures by failing fast when external services are degraded.
 *
 * States:
 * - CLOSED: Normal operation, requests pass through
 * - OPEN: Failing fast, requests rejected immediately
 * - HALF_OPEN: Testing if service recovered, limited requests allowed
 */

import { logger } from './logger';

export enum CircuitState {
  CLOSED = 'CLOSED',
  OPEN = 'OPEN',
  HALF_OPEN = 'HALF_OPEN',
}

export interface CircuitBreakerOptions {
  /** Name for logging purposes */
  name: string;
  /** Number of failures before opening circuit */
  failureThreshold: number;
  /** Time in ms before attempting recovery (moving to HALF_OPEN) */
  resetTimeout: number;
  /** Number of successful calls in HALF_OPEN to close circuit */
  successThreshold: number;
  /** Optional: time window in ms for counting failures (rolling window) */
  failureWindow?: number;
}

export interface CircuitBreakerStats {
  state: CircuitState;
  failures: number;
  successes: number;
  lastFailure: Date | null;
  lastSuccess: Date | null;
  totalRequests: number;
  rejectedRequests: number;
}

const DEFAULT_OPTIONS: Partial<CircuitBreakerOptions> = {
  failureThreshold: 5,
  resetTimeout: 30000, // 30 seconds
  successThreshold: 2,
  failureWindow: 60000, // 1 minute
};

export class CircuitBreaker {
  private state: CircuitState = CircuitState.CLOSED;
  private failures: number = 0;
  private successes: number = 0;
  private lastFailureTime: number = 0;
  private lastSuccessTime: number = 0;
  private nextAttemptTime: number = 0;
  private totalRequests: number = 0;
  private rejectedRequests: number = 0;
  private failureTimestamps: number[] = [];
  /** Tracks active probe requests in HALF_OPEN state to limit concurrency */
  private halfOpenActiveProbes: number = 0;
  private static readonly MAX_HALF_OPEN_PROBES = 1;

  private readonly options: Required<CircuitBreakerOptions>;

  constructor(options: CircuitBreakerOptions) {
    this.options = { ...DEFAULT_OPTIONS, ...options } as Required<CircuitBreakerOptions>;
  }

  /**
   * Execute a function with circuit breaker protection
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    this.totalRequests++;

    if (!this.canExecute()) {
      this.rejectedRequests++;
      const error = new CircuitBreakerError(
        `Circuit breaker '${this.options.name}' is OPEN - failing fast`,
        this.options.name,
        this.state
      );
      logger.warn(
        {
          circuitBreaker: this.options.name,
          state: this.state,
          failures: this.failures,
          nextAttemptIn: Math.max(0, this.nextAttemptTime - Date.now()),
        },
        'Circuit breaker rejected request'
      );
      throw error;
    }

    // Track active probes in HALF_OPEN state
    const isProbe = this.state === CircuitState.HALF_OPEN;
    if (isProbe) this.halfOpenActiveProbes++;

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure(error);
      throw error;
    } finally {
      if (isProbe) this.halfOpenActiveProbes--;
    }
  }

  /**
   * Check if request can proceed
   */
  private canExecute(): boolean {
    const now = Date.now();

    switch (this.state) {
      case CircuitState.CLOSED:
        return true;

      case CircuitState.OPEN:
        // Check if enough time has passed to try again
        if (now >= this.nextAttemptTime) {
          this.transitionTo(CircuitState.HALF_OPEN);
          return true;
        }
        return false;

      case CircuitState.HALF_OPEN:
        // Only allow one concurrent probe request in half-open state
        if (this.halfOpenActiveProbes >= CircuitBreaker.MAX_HALF_OPEN_PROBES) {
          return false;
        }
        return true;

      default:
        return true;
    }
  }

  /**
   * Handle successful execution
   */
  private onSuccess(): void {
    this.lastSuccessTime = Date.now();
    this.successes++;

    switch (this.state) {
      case CircuitState.HALF_OPEN:
        if (this.successes >= this.options.successThreshold) {
          this.transitionTo(CircuitState.CLOSED);
        }
        break;

      case CircuitState.CLOSED:
        // Reset failure count on success in closed state
        this.failures = 0;
        this.failureTimestamps = [];
        break;
    }
  }

  /**
   * Handle failed execution
   */
  private onFailure(error: unknown): void {
    const now = Date.now();
    this.lastFailureTime = now;
    this.failures++;
    this.failureTimestamps.push(now);

    // Clean up old failure timestamps outside the window
    const windowStart = now - this.options.failureWindow;
    this.failureTimestamps = this.failureTimestamps.filter((ts) => ts > windowStart);

    logger.warn(
      {
        circuitBreaker: this.options.name,
        state: this.state,
        failures: this.failures,
        recentFailures: this.failureTimestamps.length,
        error: error instanceof Error ? error.message : String(error),
      },
      'Circuit breaker recorded failure'
    );

    switch (this.state) {
      case CircuitState.HALF_OPEN:
        // Any failure in half-open immediately opens the circuit
        this.transitionTo(CircuitState.OPEN);
        break;

      case CircuitState.CLOSED:
        // Check if we've exceeded failure threshold in the window
        if (this.failureTimestamps.length >= this.options.failureThreshold) {
          this.transitionTo(CircuitState.OPEN);
        }
        break;
    }
  }

  /**
   * Transition to a new state
   */
  private transitionTo(newState: CircuitState): void {
    const oldState = this.state;
    this.state = newState;

    logger.info(
      {
        circuitBreaker: this.options.name,
        oldState,
        newState,
        failures: this.failures,
        successes: this.successes,
      },
      'Circuit breaker state transition'
    );

    switch (newState) {
      case CircuitState.OPEN:
        this.nextAttemptTime = Date.now() + this.options.resetTimeout;
        this.successes = 0;
        this.halfOpenActiveProbes = 0;
        break;

      case CircuitState.HALF_OPEN:
        this.successes = 0;
        this.halfOpenActiveProbes = 0;
        break;

      case CircuitState.CLOSED:
        this.failures = 0;
        this.successes = 0;
        this.failureTimestamps = [];
        this.halfOpenActiveProbes = 0;
        break;
    }
  }

  /**
   * Get current circuit breaker stats
   */
  getStats(): CircuitBreakerStats {
    return {
      state: this.state,
      failures: this.failures,
      successes: this.successes,
      lastFailure: this.lastFailureTime ? new Date(this.lastFailureTime) : null,
      lastSuccess: this.lastSuccessTime ? new Date(this.lastSuccessTime) : null,
      totalRequests: this.totalRequests,
      rejectedRequests: this.rejectedRequests,
    };
  }

  /**
   * Manually reset the circuit breaker to closed state
   */
  reset(): void {
    logger.info({ circuitBreaker: this.options.name }, 'Circuit breaker manually reset');
    this.transitionTo(CircuitState.CLOSED);
    this.totalRequests = 0;
    this.rejectedRequests = 0;
  }

  /**
   * Check if the circuit is currently open (failing fast)
   */
  isOpen(): boolean {
    return this.state === CircuitState.OPEN;
  }

  /**
   * Get the circuit breaker name
   */
  getName(): string {
    return this.options.name;
  }
}

/**
 * Custom error for circuit breaker rejections
 */
export class CircuitBreakerError extends Error {
  readonly circuitName: string;
  readonly state: CircuitState;

  constructor(message: string, circuitName: string, state: CircuitState) {
    super(message);
    this.name = 'CircuitBreakerError';
    this.circuitName = circuitName;
    this.state = state;
  }
}

/**
 * Registry for managing multiple circuit breakers
 */
class CircuitBreakerRegistry {
  private breakers: Map<string, CircuitBreaker> = new Map();

  /**
   * Get or create a circuit breaker by name
   */
  getOrCreate(options: CircuitBreakerOptions): CircuitBreaker {
    let breaker = this.breakers.get(options.name);
    if (!breaker) {
      breaker = new CircuitBreaker(options);
      this.breakers.set(options.name, breaker);
    }
    return breaker;
  }

  /**
   * Get a circuit breaker by name
   */
  get(name: string): CircuitBreaker | undefined {
    return this.breakers.get(name);
  }

  /**
   * Get stats for all circuit breakers
   */
  getAllStats(): Record<string, CircuitBreakerStats> {
    const stats: Record<string, CircuitBreakerStats> = {};
    for (const [name, breaker] of this.breakers) {
      stats[name] = breaker.getStats();
    }
    return stats;
  }

  /**
   * Reset all circuit breakers
   */
  resetAll(): void {
    for (const breaker of this.breakers.values()) {
      breaker.reset();
    }
  }
}

// Global registry instance
export const circuitBreakerRegistry = new CircuitBreakerRegistry();

// Pre-configured circuit breakers for common services
export const CIRCUIT_BREAKER_CONFIGS = {
  GMAIL_API: {
    name: 'gmail-api',
    failureThreshold: 5,
    resetTimeout: 30000, // 30 seconds
    successThreshold: 2,
    failureWindow: 60000, // 1 minute
  },
  CLAUDE_API: {
    name: 'claude-api',
    failureThreshold: 3,
    resetTimeout: 60000, // 1 minute (longer due to rate limits)
    successThreshold: 1,
    failureWindow: 120000, // 2 minutes
  },
  NOTION_API: {
    name: 'notion-api',
    failureThreshold: 5,
    resetTimeout: 30000,
    successThreshold: 2,
    failureWindow: 60000,
  },
} as const;
