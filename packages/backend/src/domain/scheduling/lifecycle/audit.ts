/**
 * Audit emission for lifecycle transitions.
 *
 * Two writes per transition, with deliberately different durability
 * contracts:
 *
 *   - `addAuditMessage` appends a narrative note to the conversation
 *     log through the versioned conversation writer
 *     (`appendConversationMessage`), which bumps `conversationVersion`.
 *     That matters when the transition happens INSIDE an agent turn
 *     (mark_scheduling_complete, cancel_appointment): the turn's next
 *     save sees the bump and rebases its messages onto the note instead
 *     of overwriting it. (The previous SQL-level `jsonb_set` append left
 *     the version alone, so the turn's end-of-turn save silently erased
 *     the note; it also still dual-wrote the dropped
 *     `appointment_conversations` mirror, which made every append fail.)
 *     Failure is swallowed — a missed narrative entry must NOT roll back
 *     a successful transition.
 *
 *   - `recordStatusChangeEvent` writes an `appointment_audit_events`
 *     row with `eventType='status_change'`. This is the queryable
 *     timeline used by debugging and work reports. The underlying
 *     `auditEventService.log` already swallows failures internally,
 *     so callers can `await` without fear of throw-through.
 *
 * The terminal transitions (completed, cancelled) write the audit
 * event INSIDE their wrapping transaction for stricter atomicity, so
 * those don't go through `recordStatusChangeEvent` — they use the
 * lower-level `auditEventService.log` directly within
 * `runTerminalTransitionTx`'s `buildAuditPayload`.
 *
 * Audit narrative accuracy note: `previousStatus` is captured from a
 * read BEFORE the atomic updateMany. For transitions with multiple
 * valid from-statuses (negotiating, confirmed, feedback_requested),
 * a concurrent process could change the actual at-write from-status —
 * the data is still consistent (the atomic guard ensures only
 * valid-from rows are updated) but the audit narrative may report the
 * read-time previous status instead of the actual at-update one.
 * Accepted as a known minor inaccuracy.
 */

import { logger } from '../../../utils/logger';
import { aiConversationService } from '../../../services/ai-conversation.service';
import { auditEventService, type AuditActor } from '../../../services/audit-event.service';
import type { AppointmentStatus } from '../../../constants';
import type { TransitionSource } from './types';

/**
 * Append a lifecycle audit note to the conversation log via the versioned
 * writer (see the module doc). Creates the log if the agent hasn't
 * written one yet. Failures are swallowed (logged at ERROR, not rethrown).
 */
export async function addAuditMessage(
  appointmentId: string,
  source: TransitionSource,
  message: string,
  adminId?: string,
): Promise<void> {
  try {
    const content = source === 'admin' && adminId
      ? `[Admin: ${adminId}] ${message}`
      : `[System: ${source}] ${message}`;
    await aiConversationService.appendConversationMessage(appointmentId, {
      role: source === 'admin' ? 'admin' : 'assistant',
      content,
    });
  } catch (err) {
    logger.error({ err, appointmentId }, 'Failed to add audit message (non-fatal)');
  }
}

/**
 * Emit a status_change row in `appointment_audit_events` so every transition
 * produces a queryable timeline entry.
 *
 * Used by the light transitions and `transitionToConfirmed` which update via
 * `updateMany` / `update` without a wrapping transaction. The terminal
 * transitions (completed, cancelled) write the audit row INSIDE their
 * transaction for stricter atomicity, so they don't go through this helper.
 *
 * Failures are swallowed (auditEventService.log already does this) — a missing
 * audit row should never roll back a successful transition. The call is
 * synchronously awaited so the audit row is committed before the status-change
 * event is propagated to listeners.
 */
export async function recordStatusChangeEvent(
  appointmentId: string,
  source: TransitionSource,
  adminId: string | undefined,
  previousStatus: AppointmentStatus,
  newStatus: AppointmentStatus,
  reason?: string,
): Promise<void> {
  const actor: AuditActor =
    source === 'admin' || source === 'agent' || source === 'system' ? source : 'system';
  await auditEventService.log(appointmentId, 'status_change', actor, {
    previousStatus,
    newStatus,
    ...(reason ? { reason } : {}),
    ...(adminId ? { adminId } : {}),
  });
}
