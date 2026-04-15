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
 * Sleep for a specified duration
 */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Re-exported from centralized TIMEOUTS in constants.ts for backward compatibility.
// New code should import TIMEOUTS from '../constants' directly.
import { TIMEOUTS } from '../constants';

export const DEFAULT_TIMEOUTS = {
  HTTP_FETCH: TIMEOUTS.HTTP_FETCH_MS,
  DATABASE: TIMEOUTS.DATABASE_MS,
  CACHE: TIMEOUTS.CACHE_MS,
  EXTERNAL_API: TIMEOUTS.EXTERNAL_API_MS,
  AI_MODEL: TIMEOUTS.AI_MODEL_MS,
  FILE_IO: TIMEOUTS.FILE_IO_MS,
} as const;
