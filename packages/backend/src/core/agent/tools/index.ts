/**
 * Public surface for the booking-agent tool executor.
 *
 * Callers construct `new AIToolExecutorService(traceId)` and call
 * `.executeToolCall(...)` / `.flagForHumanReviewFromLoop(...)`. The
 * free `executeToolCall` function is also exported for direct use.
 */

export { AIToolExecutorService, executeToolCall } from './dispatch';
