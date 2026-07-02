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
 * Recognise a transient database error that is safe to retry by
 * re-running the transaction from the top: dropped connections
 * (Prisma P1001/P1002/P1008/P1017, or the raw driver messages) and
 * interactive transactions that expired before committing (P2028,
 * "Transaction already closed"). In every one of these cases nothing
 * was committed, so a clean re-run is correct.
 *
 * Seen in prod during a DB latency blip: Gmail message processing
 * failed with "Server has closed the connection" on a read and
 * "Transaction already closed" on a conversation-state save. Both
 * self-heal on retry.
 */
const TRANSIENT_DB_ERROR_CODES = new Set(['P1001', 'P1002', 'P1008', 'P1017', 'P2028']);
const TRANSIENT_DB_ERROR_PATTERNS = [
  'Server has closed the connection',
  'Transaction already closed',
  'Connection reset by peer',
  'Connection terminated unexpectedly',
];

export function isTransientDbError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: string }).code;
  if (code && TRANSIENT_DB_ERROR_CODES.has(code)) return true;
  return TRANSIENT_DB_ERROR_PATTERNS.some((pattern) => error.message.includes(pattern));
}

/**
 * Run `fn` and retry on serialization failure or transient DB error
 * with exponential backoff. The caller passes a fn that itself opens
 * the transaction — keeping the retry policy out of the transaction
 * body so a failed attempt rolls back cleanly before we re-enter.
 *
 * All other errors propagate immediately.
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
      const retriable = isSerializationError(error) || isTransientDbError(error);
      if (retriable && attempt < SERIALIZATION_RETRY.MAX_RETRIES) {
        const delay = getBackoffDelay(attempt);
        const reason = isSerializationError(error)
          ? 'serialization conflict'
          : 'transient DB error';
        log?.(`${reason} — retrying with backoff`, {
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
