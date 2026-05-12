/**
 * Per-appointment tool-call counter (Redis-backed).
 *
 * Defence-in-depth bound on total agent activity across an appointment's
 * lifecycle. Complements the per-turn breakers in agent-tool-loop.ts
 * (turn budget, same-hash guard, error breaker) by catching cross-turn
 * drift that those can't see.
 *
 * Semantics shipped in #210: the counter measures *completed* tool calls,
 * not attempts. Idempotent skips, human-control skips, lifecycle-ceiling
 * skips, and tool errors do not advance it. The pre-flight check peeks
 * (no increment); the executor's success path is what bumps the counter.
 *
 * Lives in its own module rather than alongside the executor so the
 * routes layer (bulk-release endpoint, #209) can import the helpers
 * without dragging the entire agent execution path into its module
 * graph. All three operations fall open on Redis failure — a Redis flap
 * shouldn't paralyse either the agent (which falls back to the per-turn
 * breakers) or the operator (who can still release control without the
 * counter resetting).
 */

import { redis } from '../utils/redis';
import { logger } from '../utils/logger';
import { TOOL_EXECUTION } from '../constants';

const TOOL_COUNT_PREFIX = TOOL_EXECUTION.COUNT_PREFIX;
const TOOL_COUNT_TTL_SECONDS = TOOL_EXECUTION.COUNT_TTL_SECONDS;

/**
 * Increment the per-appointment tool-call counter and return the new
 * value. Called from the executor's success path so only completed
 * tool calls advance the counter. EXPIRE on every INCR is cheap and
 * ensures the TTL never lapses for a long-running appointment.
 */
export async function incrementAppointmentToolCount(appointmentId: string): Promise<number> {
  try {
    const key = `${TOOL_COUNT_PREFIX}${appointmentId}`;
    const count = await redis.incr(key);
    await redis.expire(key, TOOL_COUNT_TTL_SECONDS);
    return count;
  } catch (err) {
    logger.warn({ err, appointmentId }, 'Redis unavailable for per-appointment tool count');
    return 0;
  }
}

/**
 * Read the per-appointment tool-call counter without incrementing it.
 * Used for the executor's pre-flight ceiling check.
 */
export async function peekAppointmentToolCount(appointmentId: string): Promise<number> {
  try {
    const value = await redis.get(`${TOOL_COUNT_PREFIX}${appointmentId}`);
    return value ? Number(value) : 0;
  } catch (err) {
    logger.warn({ err, appointmentId }, 'Redis unavailable for per-appointment tool count peek');
    return 0;
  }
}

/**
 * Reset the per-appointment tool-call counter. Used by the bulk-release
 * operator path so a freshly-released appointment doesn't immediately
 * re-trip the ceiling on its next tool call.
 */
export async function resetAppointmentToolCount(appointmentId: string): Promise<void> {
  try {
    await redis.del(`${TOOL_COUNT_PREFIX}${appointmentId}`);
  } catch (err) {
    logger.warn({ err, appointmentId }, 'Redis unavailable for per-appointment tool count reset');
  }
}
