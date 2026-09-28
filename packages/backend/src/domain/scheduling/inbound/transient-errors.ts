/**
 * Classify errors that mean "the infrastructure is unhealthy right now",
 * as opposed to "this message cannot be processed".
 *
 * The inbound pipeline abandons a message after MAX_PROCESSING_FAILURES
 * (3) failed attempts, and the poller re-drives every unread message
 * every ~3 minutes. Counting a circuit-breaker rejection, a rate limit,
 * a timeout or a 5xx against that budget meant a ten-minute Claude or
 * Gmail incident permanently abandoned every inbound email that arrived
 * during it (one high-severity Slack alert each, each needing a manual
 * retry). Errors matched here are deferred without consuming an attempt:
 * the message stays unprocessed and is retried once the dependency
 * recovers. Genuine per-message failures (schema drift, a handler bug,
 * malformed content) still count.
 */

import { CircuitBreakerError } from '../../../utils/circuit-breaker';
import { TimeoutError } from '../../../utils/timeout';
import { RateLimitError as AppRateLimitError } from '../../../errors';

// Anthropic SDK error classes, matched by name so this module does not
// have to import the SDK client wrapper (which loads runtime config).
const ANTHROPIC_TRANSIENT_ERROR_NAMES = new Set([
  'RateLimitError',
  'APIConnectionError',
  'APIConnectionTimeoutError',
  'InternalServerError',
  'OverloadedError',
]);

const TRANSIENT_NODE_ERROR_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'ENOTFOUND',
  'EPIPE',
  'EHOSTUNREACH',
  'ENETUNREACH',
]);

// Prisma engine/connection errors (not query errors): P1001 can't reach
// DB, P1002 timed out, P1008 operation timed out, P1017 server closed.
const TRANSIENT_PRISMA_CODES = new Set(['P1001', 'P1002', 'P1008', 'P1017']);

function httpStatusOf(err: unknown): number | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const e = err as { status?: unknown; statusCode?: unknown; code?: unknown; response?: { status?: unknown } };
  for (const candidate of [e.status, e.statusCode, e.response?.status, e.code]) {
    if (typeof candidate === 'number') return candidate;
  }
  return undefined;
}

function isTransientHttpStatus(status: number | undefined): boolean {
  return status === 429 || status === 529 || (status !== undefined && status >= 500 && status < 600);
}

export function isTransientInfrastructureError(err: unknown): boolean {
  if (err instanceof CircuitBreakerError) return true;
  if (err instanceof TimeoutError) return true;
  if (err instanceof AppRateLimitError) return true;

  if (err && typeof err === 'object') {
    const e = err as { code?: unknown; name?: unknown };
    if (typeof e.name === 'string' && ANTHROPIC_TRANSIENT_ERROR_NAMES.has(e.name)) return true;
    if (typeof e.code === 'string') {
      if (TRANSIENT_NODE_ERROR_CODES.has(e.code)) return true;
      if (TRANSIENT_PRISMA_CODES.has(e.code)) return true;
    }
    if (e.name === 'PrismaClientInitializationError') return true;
    // gaxios (Gmail) surfaces HTTP status on `code` (string or number) or
    // `response.status`; the Anthropic SDK on `status`.
    if (isTransientHttpStatus(httpStatusOf(err))) return true;
    if (typeof e.code === 'string' && isTransientHttpStatus(Number(e.code))) return true;
  }
  return false;
}
