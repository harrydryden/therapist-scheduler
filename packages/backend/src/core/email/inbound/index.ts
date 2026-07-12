/**
 * Public surface for what's left of the inbound email pipeline under
 * core/. The orchestrator (`processMessage`) and the agent-processor DI
 * registry moved to `domain/scheduling/inbound/` in Stage D3 (see
 * docs/AGENT_HARNESS_LIFECYCLE_REVIEW.md) — both were scheduling policy,
 * not kernel mechanism. What remains here is generic per-message
 * processing-failure bookkeeping, used by tests and the admin UI's
 * MISSED-message preview.
 */

export {
  getLastProcessingError,
  getLastProcessingErrors,
} from './processing-failures';
