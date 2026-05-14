/**
 * Audit emission for lifecycle transitions.
 *
 * Two writes per transition, with deliberately different durability
 * contracts:
 *
 *   - `addAuditMessage` appends to the `conversation_state.messages`
 *     JSON blob. It uses an SQL-level `jsonb_set + ||` mutation so we
 *     don't read/parse/serialize the entire blob (up to 500KB) just to
 *     stamp one new line. Failure is swallowed — a missed narrative
 *     entry must NOT roll back a successful transition.
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

import { prisma } from '../../../utils/database';
import { logger } from '../../../utils/logger';
import { auditEventService, type AuditActor } from '../../../services/audit-event.service';
import type { AppointmentStatus } from '../../../constants';
import type { TransitionSource } from './types';

/**
 * Add an audit message to the conversation state using SQL-level JSON append.
 * This avoids reading/parsing/serializing the full blob (up to 500KB) for each
 * status transition. Failures are swallowed (logged at ERROR but not rethrown).
 */
export async function addAuditMessage(
  appointmentId: string,
  source: TransitionSource,
  message: string,
  adminId?: string,
): Promise<void> {
  try {
    const auditContent = source === 'admin' && adminId
      ? `[Admin: ${adminId}] ${message}`
      : `[System: ${source}] ${message}`;

    const newMessage = JSON.stringify({
      role: source === 'admin' ? 'admin' : 'assistant',
      content: auditContent,
    });

    // Use SQL-level JSON append to avoid full blob round-trip.
    // If conversation_state is NULL, initialize it with a new messages array.
    // If it exists, append to the existing messages array using jsonb_set + ||.
    //
    // Phase 3a dual-write: the same jsonb_set logic is applied to the
    // sibling `appointment_conversations` row. Both writes go through
    // a single $transaction so a partial-write divergence is impossible.
    // The dual-write is an UPSERT (INSERT ON CONFLICT DO UPDATE) so it
    // works whether or not the conversation row exists yet — the very
    // first audit message on a fresh appointment creates the row.
    await prisma.$transaction([
      prisma.$executeRaw`
        UPDATE "appointment_requests"
        SET "conversation_state" = CASE
          WHEN "conversation_state" IS NULL THEN
            jsonb_build_object('messages', jsonb_build_array(${newMessage}::jsonb))
          ELSE
            jsonb_set(
              "conversation_state",
              '{messages}',
              COALESCE("conversation_state"->'messages', '[]'::jsonb) || ${newMessage}::jsonb
            )
          END,
          "updated_at" = NOW()
        WHERE "id" = ${appointmentId}
      `,
      prisma.$executeRaw`
        INSERT INTO "appointment_conversations" ("appointment_id", "conversation_state", "updated_at")
        VALUES (
          ${appointmentId},
          jsonb_build_object('messages', jsonb_build_array(${newMessage}::jsonb)),
          NOW()
        )
        ON CONFLICT ("appointment_id") DO UPDATE
        SET "conversation_state" = CASE
          WHEN "appointment_conversations"."conversation_state" IS NULL THEN
            jsonb_build_object('messages', jsonb_build_array(${newMessage}::jsonb))
          ELSE
            jsonb_set(
              "appointment_conversations"."conversation_state",
              '{messages}',
              COALESCE("appointment_conversations"."conversation_state"->'messages', '[]'::jsonb) || ${newMessage}::jsonb
            )
          END,
          "updated_at" = NOW()
      `,
    ]);
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
