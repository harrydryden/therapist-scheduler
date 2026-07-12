/**
 * Redis-backed idempotency for agent tool calls.
 *
 * Each call's (appointmentId, toolName, input) is canonical-hashed
 * and stored in Redis with a TTL. The hash is checked before
 * execution; a hit means a previous attempt (e.g. a retry within
 * the same turn or a near-simultaneous duplicate) already ran the
 * tool, so we skip to avoid duplicate emails, double-confirmations,
 * voucher reissues, etc.
 *
 * Fail-closed on Redis unavailability: when we can't read the
 * idempotency key we assume the tool already ran. The previous
 * fail-open semantics meant a Redis flap during a turn could send
 * duplicate emails to the therapist / client — recoverable but
 * visible to real users. Failing closed instead pauses tool activity
 * until Redis recovers; the next inbound email picks the conversation
 * back up cleanly. Logged at error level so an outage isn't silent.
 *
 * Marking happens AFTER successful completion (in the orchestrator)
 * so failed executions don't dedupe a real retry.
 *
 * Shared across both agent loops: the booking agent (keyed on
 * appointmentRequestId, default key prefix) and the availability
 * agent (keyed on conversationId, its own `keyPrefix` so the two
 * namespaces can't collide). `wasToolExecuted`/`markToolExecuted`
 * accept an optional `keyPrefix` for exactly this; omit it to use
 * the default `TOOL_EXECUTION.PREFIX`.
 */

import crypto from 'crypto';
import { logger } from '../../../utils/logger';
import { redis } from '../../../utils/redis';
import { canonicalStringify } from '../../../utils/canonical-json';
import { TOOL_EXECUTION } from '../../../constants';

const TOOL_EXECUTION_PREFIX = TOOL_EXECUTION.PREFIX;
const TOOL_EXECUTION_TTL_SECONDS = TOOL_EXECUTION.TTL_SECONDS;

/**
 * Generate a deterministic hash for a tool call to enable idempotency
 * checking. canonicalStringify sorts keys at every depth so {a,b} and
 * {b,a} hash identically — important because the Anthropic API doesn't
 * guarantee property ordering across retries or model versions.
 */
export function hashToolCall(appointmentId: string, toolName: string, input: unknown): string {
  const data = canonicalStringify({ appointmentId, toolName, input });
  return crypto.createHash('sha256').update(data).digest('hex').substring(0, 32);
}

/**
 * Check if a tool call was already executed. Returns true if already
 * executed (skip), false if new (proceed).
 *
 * Fail-closed: returns true on Redis error so a Redis outage doesn't
 * produce duplicate side effects.
 *
 * `keyPrefix` defaults to the shared `TOOL_EXECUTION.PREFIX`; callers
 * with their own namespace (e.g. the availability agent) pass their
 * own prefix so the two hash spaces can't collide.
 */
export async function wasToolExecuted(
  hash: string,
  keyPrefix: string = TOOL_EXECUTION_PREFIX,
): Promise<boolean> {
  try {
    const result = await redis.get(`${keyPrefix}${hash}`);
    return result !== null;
  } catch (err) {
    logger.error(
      { err, hash, keyPrefix },
      'Redis unavailable for idempotency check — failing closed (skipping tool to avoid duplicate)',
    );
    return true;
  }
}

/**
 * Mark a tool call as executed. Called after successful completion
 * so failed executions don't dedupe a real retry. Fail-soft: a Redis
 * write failure is logged but doesn't fail the tool call.
 */
export async function markToolExecuted(
  hash: string,
  traceId: string,
  keyPrefix: string = TOOL_EXECUTION_PREFIX,
): Promise<void> {
  try {
    await redis.set(
      `${keyPrefix}${hash}`,
      traceId,
      'EX',
      TOOL_EXECUTION_TTL_SECONDS,
    );
  } catch (err) {
    logger.warn({ err, hash, traceId, keyPrefix }, 'Failed to mark tool as executed - idempotency may not work');
  }
}
