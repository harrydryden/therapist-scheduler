/**
 * Helpers for retrying a Prisma `$transaction` after a Postgres
 * serialization failure (SQLSTATE 40001 / Prisma P2034). Postgres can
 * reject one transaction in a conflict pair when the isolation level
 * is Serializable; the convention is to re-run from the top.
 *
 * Extracted from therapist-booking-status.service.ts so other services
 * (e.g. therapist-availability.service.ts) can share the same retry
 * policy rather than each redefining backoff constants.
 */
import { sleep } from './timeout';

export const SERIALIZATION_RETRY = {
  MAX_RETRIES: 3,
  BASE_DELAY_MS: 50,
  MAX_DELAY_MS: 500,
  JITTER_FACTOR: 0.2,
} as const;

/** Exponential backoff with bounded jitter, in ms. */
export function getBackoffDelay(attempt: number): number {
  const baseDelay = SERIALIZATION_RETRY.BASE_DELAY_MS * Math.pow(2, attempt);
  const cappedDelay = Math.min(baseDelay, SERIALIZATION_RETRY.MAX_DELAY_MS);
  const jitter = cappedDelay * SERIALIZATION_RETRY.JITTER_FACTOR * Math.random();
  return cappedDelay + jitter;
}

/**
 * Recognise a Prisma/Postgres serialization failure. We match on both
 * the textual message (Postgres surface) and Prisma's P2034 code so we
 * stay correct whether the error escapes the driver as a typed code or
 * as a raw error string.
 */
export function isSerializationError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if ((error as { code?: string }).code === 'P2034') return true;
  return error.message.includes('could not serialize');
}

/**
 * Run `fn` and retry on serialization failure with exponential backoff.
 * The caller passes a fn that itself opens the transaction — keeping
 * the retry policy out of the transaction body so a serialization
 * error rolls back cleanly before we re-enter.
 *
 * Non-serialization errors propagate immediately.
 */
export async function withSerializationRetry<T>(
  fn: () => Promise<T>,
  context: Record<string, unknown> = {},
  log?: (msg: string, ctx: Record<string, unknown>) => void,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= SERIALIZATION_RETRY.MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (isSerializationError(error) && attempt < SERIALIZATION_RETRY.MAX_RETRIES) {
        const delay = getBackoffDelay(attempt);
        log?.('serialization conflict — retrying with backoff', {
          ...context,
          attempt: attempt + 1,
          delayMs: delay,
        });
        await sleep(delay);
        continue;
      }
      throw error;
    }
  }
  // Unreachable in practice — the loop either returns or throws — but
  // keeps TypeScript's control-flow analysis honest.
  throw lastError;
}
