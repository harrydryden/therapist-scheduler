/**
 * Timeout Utilities
 *
 * Provides timeout wrappers for async operations to prevent hanging requests.
 * Critical for external service calls (Slack, Notion, Claude, Gmail).
 */

import { logger } from './logger';

/**
 * Custom error for timeout conditions
 */
export class TimeoutError extends Error {
  readonly operation: string;
  readonly timeoutMs: number;
  readonly timestamp: Date;

  constructor(operation: string, timeoutMs: number) {
    super(`Operation '${operation}' timed out after ${timeoutMs}ms`);
    this.name = 'TimeoutError';
    this.operation = operation;
    this.timeoutMs = timeoutMs;
    this.timestamp = new Date();
  }
}

/**
 * Timeout tracking for monitoring
 * Tracks recent timeouts to detect systemic issues
 */
interface TimeoutRecord {
  operation: string;
  timeoutMs: number;
  timestamp: Date;
}

const recentTimeouts: TimeoutRecord[] = [];
const MAX_TIMEOUT_RECORDS = 100;
const TIMEOUT_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Record a timeout for monitoring
 */
function recordTimeout(operation: string, timeoutMs: number): void {
  const now = new Date();

  // Clean up old records
  const cutoff = now.getTime() - TIMEOUT_WINDOW_MS;
  while (recentTimeouts.length > 0 && recentTimeouts[0].timestamp.getTime() < cutoff) {
    recentTimeouts.shift();
  }

  // Add new record
  recentTimeouts.push({ operation, timeoutMs, timestamp: now });

  // Enforce max size
  while (recentTimeouts.length > MAX_TIMEOUT_RECORDS) {
    recentTimeouts.shift();
  }

  // Log warning if too many timeouts in window
  const timeoutCount = recentTimeouts.length;
  if (timeoutCount >= 5) {
    const operationCounts: Record<string, number> = {};
    for (const record of recentTimeouts) {
      operationCounts[record.operation] = (operationCounts[record.operation] || 0) + 1;
    }
    logger.warn(
      { timeoutCount, windowMinutes: TIMEOUT_WINDOW_MS / 60000, operationCounts },
      'High timeout rate detected - possible service degradation'
    );
  }
}

/**
 * Get timeout statistics for monitoring
 */
export function getTimeoutStats(): {
  recentCount: number;
  windowMinutes: number;
  byOperation: Record<string, number>;
} {
  const now = Date.now();
  const cutoff = now - TIMEOUT_WINDOW_MS;
  const recent = recentTimeouts.filter(r => r.timestamp.getTime() >= cutoff);

  const byOperation: Record<string, number> = {};
  for (const record of recent) {
    byOperation[record.operation] = (byOperation[record.operation] || 0) + 1;
  }

  return {
    recentCount: recent.length,
    windowMinutes: TIMEOUT_WINDOW_MS / 60000,
    byOperation,
  };
}

/**
 * Wrap a promise with a timeout
 *
 * @param promise - The promise to wrap
 * @param timeoutMs - Timeout in milliseconds
 * @param operation - Name of the operation (for error messages)
 * @returns The promise result if completed in time
 * @throws TimeoutError if the operation takes too long
 *
 * @example
 * const result = await withTimeout(
 *   fetch('https://api.example.com/data'),
 *   5000,
 *   'fetch-data'
 * );
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  operation: string,
  context?: Record<string, unknown>
): Promise<T> {
  let timeoutId: NodeJS.Timeout | undefined;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      // Record for monitoring
      recordTimeout(operation, timeoutMs);
      // Log with context
      logger.warn({ operation, timeoutMs, ...context }, `Operation timed out`);
      reject(new TimeoutError(operation, timeoutMs));
    }, timeoutMs);
  });

  try {
    const result = await Promise.race([promise, timeoutPromise]);
    clearTimeout(timeoutId);
    return result;
  } catch (error) {
    clearTimeout(timeoutId);
    throw error;
  }
}

/**
 * Wrap a function to automatically apply timeout to its result
 *
 * @param fn - The async function to wrap
 * @param timeoutMs - Timeout in milliseconds
 * @param operation - Name of the operation
 * @returns A wrapped function that applies timeout
 *
 * @example
 * const fetchWithTimeout = withTimeoutFn(
 *   async (url: string) => fetch(url),
 *   5000,
 *   'fetch'
 * );
 * const result = await fetchWithTimeout('https://api.example.com');
 */
export function withTimeoutFn<TArgs extends unknown[], TResult>(
  fn: (...args: TArgs) => Promise<TResult>,
  timeoutMs: number,
  operation: string
): (...args: TArgs) => Promise<TResult> {
  return async (...args: TArgs): Promise<TResult> => {
    return withTimeout(fn(...args), timeoutMs, operation);
  };
}

/**
 * Execute with timeout and fallback
 *
 * @param promise - The promise to execute
 * @param timeoutMs - Timeout in milliseconds
 * @param fallback - Fallback value or function to call on timeout
 * @param operation - Name of the operation
 * @returns The result or fallback value
 *
 * @example
 * const data = await withTimeoutAndFallback(
 *   fetchFromCache(),
 *   1000,
 *   { cached: false, data: [] },
 *   'cache-fetch'
 * );
 */
export async function withTimeoutAndFallback<T>(
  promise: Promise<T>,
  timeoutMs: number,
  fallback: T | (() => T),
  operation: string
): Promise<T> {
  try {
    return await withTimeout(promise, timeoutMs, operation);
  } catch (error) {
    if (error instanceof TimeoutError) {
      logger.info({ operation, timeoutMs }, 'Using fallback value after timeout');
      return typeof fallback === 'function' ? (fallback as () => T)() : fallback;
    }
    throw error;
  }
}

/**
 * Retry with timeout and exponential backoff
 *
 * @param fn - The async function to retry
 * @param options - Retry configuration
 * @returns The result of the successful attempt
 *
 * @example
 * const result = await retryWithTimeout(
 *   () => callExternalApi(),
 *   {
 *     maxAttempts: 3,
 *     timeoutMs: 5000,
 *     backoffMs: 1000,
 *     operation: 'external-api-call'
 *   }
 * );
 */
export async function retryWithTimeout<T>(
  fn: () => Promise<T>,
  options: {
    maxAttempts: number;
    timeoutMs: number;
    backoffMs: number;
    operation: string;
    /** Whether to retry on timeout (default: true) */
    retryOnTimeout?: boolean;
    /** Backoff multiplier (default: 2 for exponential) */
    backoffMultiplier?: number;
    /** Maximum backoff time (default: 30000ms) */
    maxBackoffMs?: number;
  }
): Promise<T> {
  const {
    maxAttempts,
    timeoutMs,
    backoffMs,
    operation,
    retryOnTimeout = true,
    backoffMultiplier = 2,
    maxBackoffMs = 30000,
  } = options;

  let lastError: Error | undefined;
  let currentBackoff = backoffMs;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await withTimeout(fn(), timeoutMs, `${operation}-attempt-${attempt}`);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      const isTimeout = error instanceof TimeoutError;
      const shouldRetry = attempt < maxAttempts && (retryOnTimeout || !isTimeout);

      if (shouldRetry) {
        logger.warn(
          {
            operation,
            attempt,
            maxAttempts,
            error: lastError.message,
            nextRetryMs: currentBackoff,
          },
          'Retrying operation after failure'
        );

        await sleep(currentBackoff);
        currentBackoff = Math.min(currentBackoff * backoffMultiplier, maxBackoffMs);
      } else {
        logger.error(
          {
            operation,
            attempt,
            maxAttempts,
            error: lastError.message,
          },
          'Operation failed after all retries'
        );
      }
    }
  }

  throw lastError;
}

/**
 * Sleep for a specified duration
 */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Default timeouts for common operations
export const DEFAULT_TIMEOUTS = {
  /** HTTP fetch operations */
  HTTP_FETCH: 30000,
  /** Database queries */
  DATABASE: 10000,
  /** Cache operations */
  CACHE: 5000,
  /** External API calls (Slack, etc.) */
  EXTERNAL_API: 15000,
  /** AI model calls (Claude) */
  AI_MODEL: 120000,
  /** File operations */
  FILE_IO: 30000,
} as const;
