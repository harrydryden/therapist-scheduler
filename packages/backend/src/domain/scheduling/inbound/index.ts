/**
 * Public surface for the inbound email pipeline's scheduling-policy
 * half. Moved from core/email/inbound/ in Stage D3 (see
 * docs/AGENT_HARNESS_LIFECYCLE_REVIEW.md) — this orchestrates
 * appointment matching, invitation replies, weekly-mailing routing,
 * therapist-nudge detection, and closure recommendations, none of which
 * survive core/README.md's "would be roughly correct in an ATS context"
 * test.
 *
 * Most callers only need `processMessage` (the orchestrator) and
 * `registerAgentProcessor` (DI plumbing, called once at startup from
 * server.ts). The generic message-processing bookkeeping this pipeline
 * also uses (processing-failure tracking, lock renewal, the message-dedup
 * facade) stays in core/email/ and core/messaging/ — see process.ts's
 * own imports.
 */

export { processMessage } from './process';
export { registerAgentProcessor, type AgentProcessor } from './agent-processor';
