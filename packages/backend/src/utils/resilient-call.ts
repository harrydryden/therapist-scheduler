/**
 * Resilient Call Utility
 *
 * Consolidates the retry-with-backoff pattern that was duplicated between:
 *   - ai.service.ts (transient-only retries)
 *   - justin-time.service.ts (rate-limit + transient retries + circuit breaker)
 *
 * Provides a single composable function that handles:
 *   1. Rate limit errors (429) with configurable backoff + server retry-after
 *   2. Transient errors (5xx, connection) with shorter backoff
 *   3. Circuit breaker integration (optional), applied to each attempt
 *   4. Jitter to prevent thundering herd
 *
 * Usage:
 *   const result = await resilientCall(
 *     () => anthropicClient.messages.create({...}),
 *     { context: 'processEmailReply', traceId, circuitBreaker }
 *   );
 */

import {
  isTransientError,
  addJitter,
  RateLimitError,
} from './anthropic-client';
import { sleep } from './timeout';
import { logger } from './logger';
import { CLAUDE_API } from '../constants';
import { type CircuitBreaker, CircuitBreakerError } from './circuit-breaker';

export interface ResilientCallConfig {
  /** Context string for log messages */
  context: string;
  /** Trace ID for correlation */
  traceId: string;
  /** Optional circuit breaker; every attempt goes through it */
  circuitBreaker?: CircuitBreaker;
  /** Rate-limit retry config (defaults to CLAUDE_API constants) */
  rateLimitRetries?: number;
  rateLimitDelaysMs?: readonly number[];
  /** Transient error retry config */
  transientRetries?: number;
  transientDelaysMs?: readonly number[];
  /** Maximum server retry-after we'll honor (ms) */
  maxServerRetryAfterMs?: number;
}

const DEFAULT_TRANSIENT_CONFIG = {
  retries: 2,
  delaysMs: [2000, 5000, 10000] as readonly number[],
} as const;

/**
 * Execute an async operation with layered retry logic:
 *   - Rate limit (429): longer backoff, respects server Retry-After header
 *   - Transient (5xx, network): shorter backoff
 *   - Non-retryable: thrown immediately
 *
 * If a circuitBreaker is provided, EACH attempt runs through
 * `circuitBreaker.execute()` and the back-off sleeps happen outside it.
 * Wrapping the whole loop instead meant a HALF_OPEN probe that hit a 429
 * held the breaker's single probe slot through the entire rate-limit
 * back-off (up to ~111 minutes), rejecting every other caller. A breaker
 * rejection (CircuitBreakerError) is not retried: failing fast is the
 * point of the breaker.
 */
export async function resilientCall<T>(
  operation: () => Promise<T>,
  config: ResilientCallConfig,
): Promise<T> {
  const {
    context,
    traceId,
    circuitBreaker,
    rateLimitRetries = CLAUDE_API.MAX_RETRIES,
    rateLimitDelaysMs = CLAUDE_API.RETRY_DELAYS_MS,
    transientRetries = DEFAULT_TRANSIENT_CONFIG.retries,
    transientDelaysMs = DEFAULT_TRANSIENT_CONFIG.delaysMs,
    maxServerRetryAfterMs = 5 * 60 * 1000,
  } = config;

  const attemptOnce = circuitBreaker
    ? () => circuitBreaker.execute(operation)
    : operation;

  let rateLimitAttempts = 0;
  let transientAttempts = 0;

  // Maximum total attempts is bounded: initial + rate limit retries + transient retries
  const maxAttempts = 1 + rateLimitRetries + transientRetries;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await attemptOnce();
    } catch (error) {
      if (error instanceof CircuitBreakerError) {
        throw error;
      }

      // Rate limit error (429)
      if (error instanceof RateLimitError) {
        rateLimitAttempts++;
        if (rateLimitAttempts > rateLimitRetries) {
          logger.error(
            { traceId, context, rateLimitAttempts, maxRetries: rateLimitRetries },
            'Rate limit retries exhausted',
          );
          throw error;
        }

        const retryDelay = computeRateLimitDelay(
          error, rateLimitAttempts, rateLimitDelaysMs, maxServerRetryAfterMs, traceId, context,
        );

        logger.warn(
          { traceId, context, attempt: rateLimitAttempts, maxRetries: rateLimitRetries, retryDelayMs: retryDelay },
          `Rate limited (429) — retrying in ${Math.round(retryDelay / 1000)}s`,
        );
        await sleep(retryDelay);
        continue;
      }

      // Transient error (5xx, connection issues)
      if (isTransientError(error)) {
        transientAttempts++;
        if (transientAttempts > transientRetries) {
          logger.error(
            { traceId, context, transientAttempts, maxRetries: transientRetries },
            'Transient error retries exhausted',
          );
          throw error;
        }

        const baseDelay = transientDelaysMs[Math.min(transientAttempts - 1, transientDelaysMs.length - 1)];
        const retryDelay = addJitter(baseDelay);

        logger.warn(
          { traceId, context, attempt: transientAttempts, maxRetries: transientRetries, retryDelayMs: retryDelay },
          `Transient error — retrying in ${Math.round(retryDelay / 1000)}s`,
        );
        await sleep(retryDelay);
        continue;
      }

      // Non-retryable error
      throw error;
    }
  }

  // Should never reach here, but TypeScript needs this
  throw new Error(`resilientCall: unexpected loop exit (${context})`);
}

/**
 * Compute the delay for a rate-limit retry, honoring server Retry-After if present.
 */
function computeRateLimitDelay(
  error: RateLimitError,
  attempt: number,
  delaysMs: readonly number[],
  maxServerRetryAfterMs: number,
  traceId: string,
  context: string,
): number {
  const rateLimitError = error as RateLimitError & { headers?: Record<string, string> };
  const retryAfterHeader = rateLimitError.headers?.['retry-after'];

  if (retryAfterHeader) {
    const serverDelaySeconds = parseInt(retryAfterHeader, 10);
    if (!isNaN(serverDelaySeconds) && serverDelaySeconds > 0) {
      const serverDelayMs = serverDelaySeconds * 1000;
      if (serverDelayMs <= maxServerRetryAfterMs) {
        logger.info(
          { traceId, context, serverRetryAfter: serverDelaySeconds },
          'Using server-provided retry-after delay',
        );
        return addJitter(serverDelayMs);
      }
      logger.warn(
        { traceId, context, serverRetryAfter: serverDelaySeconds, maxAllowed: maxServerRetryAfterMs / 1000 },
        'Server retry-after exceeds max — using capped delay',
      );
      return addJitter(maxServerRetryAfterMs);
    }
  }

  const baseDelay = delaysMs[Math.min(attempt - 1, delaysMs.length - 1)];
  return addJitter(baseDelay);
}
