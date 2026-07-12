/**
 * Admin force-update — the deliberate state-machine bypass.
 *
 * Used by the admin appointments dashboard where admins need
 * unrestricted control to fix data that the lifecycle FSM wouldn't
 * otherwise allow (e.g. flipping a "completed" back to "confirmed"
 * for an incorrectly-completed appointment).
 *
 * GUARDRAILS — every call MUST:
 *   - pass `bypassStateMachine: true` (TypeScript literal-true; runtime
 *     re-check defends against `as any`);
 *   - supply a non-empty `reason` (logged loudly, persisted to audit,
 *     and Slack-alerted on status change);
 *   - supply a non-empty `adminId` (so the bypass record stays
 *     traceable in audit + Slack).
 *
 * Behaviours:
 *   - FOR UPDATE row lock around the read-modify-write (TOCTOU
 *     protection — concurrent writes can't fire side effects on stale
 *     previousStatus).
 *   - Backward sentinel resets: moving backwards in the lifecycle
 *     clears post-stage follow-up sentinels so automated services
 *     re-send the appropriate emails.
 *   - Active-status reschedule flagging: clearing the date on an
 *     active appointment marks it as `reschedulingInProgress` so the
 *     UI/agent know to chase a new datetime.
 *   - Slack alert (severity=high) on status changes only — date-only
 *     edits don't alert (would be noise).
 *
 * Always performs: audit trail, SSE notification, confirmedAt management,
 * therapist booking status, sync. Optionally performs: emails, Slack
 * (controlled by skipNotifications, default true).
 */

import { prisma } from '../../../utils/database';
import { logger } from '../../../utils/logger';
import { APPOINTMENT_STATUS, type AppointmentStatus } from '../../../constants';
import { AppointmentNotFoundError } from '../../../errors';
import { transitionSideEffectsService } from '../../../services/transition-side-effects.service';
import { recordAppointmentEvent } from '../../../services/appointment-event.service';
import { isTerminalAppointmentStatus } from '../../../services/terminal-appointment-guard';
import { addAuditMessage, recordStatusChangeEvent } from './audit';
import { CLEAR_RESCHEDULING_STATE, startReschedulingState } from './update-fragments';
import {
  computeBackwardSentinelResets,
  progressionResetsFor,
} from './status-order';
import { fireAndForget } from './dispatch-helpers';
import type { TransitionResult } from './types';

export async function adminForceUpdate(
  appointmentId: string,
  options: {
    newStatus?: AppointmentStatus;
    confirmedDateTime?: string | null;
    confirmedDateTimeParsed?: Date | null;
    adminId: string;
    /** Required acknowledgement that this call bypasses state machine validation. */
    bypassStateMachine: true;
    /** Required justification — logged + audited + (for status changes) Slack-alerted. */
    reason: string;
    skipNotifications?: boolean;
  },
): Promise<TransitionResult> {
  const { newStatus, confirmedDateTime, confirmedDateTimeParsed, adminId, reason, bypassStateMachine } = options;
  const skipNotifications = options.skipNotifications ?? true;
  const logContext = { appointmentId, adminId };

  // Runtime checks defend against the route layer constructing this
  // options object from a request body (where TypeScript can't enforce
  // the literal-true type) or any caller using `as any`.
  if (bypassStateMachine !== true) {
    throw new Error('adminForceUpdate requires bypassStateMachine: true');
  }
  if (!reason || reason.trim().length === 0) {
    throw new Error('adminForceUpdate requires a non-empty reason');
  }
  // adminId carries through to the audit message ("[Admin: <id>]"), the
  // status_change event payload, and the Slack alert "additionalFields".
  // An empty string would render as "Admin: " — validate to keep the bypass
  // record traceable.
  if (!adminId || adminId.trim().length === 0) {
    throw new Error('adminForceUpdate requires a non-empty adminId');
  }

  // Loud warning so any bypass shows up in logs at WARN level (not just info).
  logger.warn(
    { ...logContext, reason, newStatus, confirmedDateTime },
    'STATE MACHINE BYPASS: adminForceUpdate called',
  );

  // Use transaction with FOR UPDATE row lock to prevent TOCTOU races.
  // Without this, another process could change the status between our
  // read and write, causing side effects to fire based on a stale
  // previousStatus.
  type AdminForceUpdateRow = {
    id: string;
    status: string;
    confirmed_date_time: string | null;
    confirmed_at: Date | null;
    user_name: string | null;
    user_email: string;
    therapist_name: string;
    therapist_email: string | null;
    therapist_handle: string;
  };

  let appointment!: {
    id: string;
    status: string;
    confirmedDateTime: string | null;
    confirmedAt: Date | null;
    userName: string | null;
    userEmail: string;
    therapistName: string;
    therapistEmail: string | null;
    therapistHandle: string;
  };
  // Track whether sentinel fields were reset inside the transaction for audit trail
  let sentinelFieldsReset = false;

  await prisma.$transaction(async (tx) => {
    // Lock the row with FOR UPDATE (no NOWAIT — see transitionToCompleted
    // comment) to prevent concurrent modifications.
    const rows = await tx.$queryRaw<AdminForceUpdateRow[]>`
      SELECT id, status, confirmed_date_time, confirmed_at, user_name, user_email,
             therapist_name, therapist_email, therapist_handle
      FROM "appointment_requests"
      WHERE id = ${appointmentId}
      FOR UPDATE
    `;
    const row: AdminForceUpdateRow | null = rows[0] || null;

    if (!row) {
      throw new AppointmentNotFoundError(appointmentId);
    }

    // Map snake_case DB columns to camelCase
    appointment = {
      id: row.id,
      status: row.status,
      confirmedDateTime: row.confirmed_date_time,
      confirmedAt: row.confirmed_at,
      userName: row.user_name,
      userEmail: row.user_email,
      therapistName: row.therapist_name,
      therapistEmail: row.therapist_email,
      therapistHandle: row.therapist_handle,
    };

    const previousStatus = appointment.status as AppointmentStatus;
    const statusChanging = newStatus && newStatus !== previousStatus;
    const dateChanging = confirmedDateTime !== undefined && confirmedDateTime !== appointment.confirmedDateTime;

    if (!statusChanging && !dateChanging) {
      return; // Will handle the early return after the transaction
    }

    // Build typed update data
    const updateData: Parameters<typeof prisma.appointmentRequest.update>[0]['data'] = {
      updatedAt: new Date(),
      lastActivityAt: new Date(),
    };

    if (statusChanging) {
      updateData.status = newStatus;
      // Admin force-update is the path that re-flips status (e.g.
      // cancel → re-confirm). Bumping generation here is the whole
      // point of the column — without it, side-effects from the
      // re-entered status dedupe against the prior generation.
      updateData.transitionGeneration = { increment: 1 };
      if (newStatus === APPOINTMENT_STATUS.CONFIRMED && !appointment.confirmedAt) {
        updateData.confirmedAt = new Date();
      }

      // Reset follow-up sentinel fields when moving backwards past the stage
      // they guard. Without this, automated services (post-booking follow-up)
      // would skip re-sending emails because the sentinel is already set
      // from the first pass through the lifecycle.
      const backwardResets = computeBackwardSentinelResets(previousStatus, newStatus);
      Object.assign(updateData, backwardResets.updates);
      if (backwardResets.reset) {
        sentinelFieldsReset = true;
      }

      // Terminal statuses (completed/cancelled) supersede any in-progress reschedule.
      // Clear rescheduling state so the record is clean.
      if (isTerminalAppointmentStatus(newStatus)) {
        Object.assign(updateData, CLEAR_RESCHEDULING_STATE);
      }

      // Centralised "progressing past pre-booking" resets (e.g. clear isStale).
      Object.assign(updateData, progressionResetsFor(newStatus));
    }

    if (dateChanging) {
      updateData.confirmedDateTime = confirmedDateTime;
      updateData.confirmedDateTimeParsed = confirmedDateTimeParsed ?? null;

      // When clearing the date on an active appointment, mark as rescheduling.
      // Routed through the shared startReschedulingState fragment (see
      // update-fragments.ts) so this path picks up the
      // meetingLinkCheckSentAt/reminderSentAt clears the agent-driven writers
      // apply — previously omitted here, which left stale post-booking
      // sentinels behind an admin-initiated reschedule.
      //
      // checkpointStage is still set directly here, unlike the agent's
      // initiate_reschedule handler (which deliberately leaves it to the
      // subsequent storeConversationState JSON-checkpoint sync): there is no
      // such downstream sync on this admin-bypass path, so this is the only
      // writer, and the admin dashboard's next-action label (next-action.ts)
      // reads checkpointStage directly.
      const effectiveStatus = newStatus || previousStatus;
      const isActiveStatus = !isTerminalAppointmentStatus(effectiveStatus);
      if (!confirmedDateTime && isActiveStatus && appointment.confirmedDateTime) {
        Object.assign(
          updateData,
          startReschedulingState({
            initiatedBy: `admin:${adminId}`,
            previousConfirmedDateTime: appointment.confirmedDateTime,
          }),
        );
        updateData.checkpointStage = 'rescheduling';
      }

      // When setting a new date, clear the rescheduling flag
      if (confirmedDateTime) {
        Object.assign(updateData, CLEAR_RESCHEDULING_STATE);
      }
    }

    await tx.appointmentRequest.update({
      where: { id: appointmentId },
      data: updateData,
      select: { id: true }, // Minimal select to avoid RETURNING columns that may not exist in DB yet
    });
  }, {
    maxWait: 5000,
    timeout: 10000,
  });

  if (!appointment) {
    throw new AppointmentNotFoundError(appointmentId);
  }

  const previousStatus = appointment.status as AppointmentStatus;
  const statusChanging = newStatus && newStatus !== previousStatus;
  const dateChanging = confirmedDateTime !== undefined && confirmedDateTime !== appointment.confirmedDateTime;

  if (!statusChanging && !dateChanging) {
    return { success: true, previousStatus, newStatus: previousStatus, skipped: true };
  }

  // Audit trail
  const effectiveNewStatus = newStatus || previousStatus;
  const auditParts: string[] = [];
  if (statusChanging) {
    auditParts.push(`Status changed: ${previousStatus} → ${newStatus}`);
    if (sentinelFieldsReset) {
      auditParts.push('Follow-up email flags reset (moved backwards in lifecycle)');
    }
  }
  if (dateChanging) {
    auditParts.push(`Date/time updated: ${appointment.confirmedDateTime || 'none'} → ${confirmedDateTime || 'none'}`);
  }
  if (reason) {
    auditParts.push(`Reason: ${reason}`);
  }
  await addAuditMessage(appointmentId, 'admin', auditParts.join('. '), adminId);

  // Emit a status_change row when status actually changes, so a query for
  // "all status transitions for this appointment" picks up admin overrides
  // alongside the normal lifecycle transitions. The dedicated
  // `admin_force_update` checkpoint event below carries the bypass-specific
  // metadata (Slack alert, bypassed-state-machine flag) — both are needed
  // because they answer different questions.
  if (statusChanging) {
    await recordStatusChangeEvent(
      appointmentId,
      'admin',
      adminId,
      previousStatus,
      effectiveNewStatus as AppointmentStatus,
      reason,
    );
  }

  // Side effects + SSE in the same order other transitions use:
  // queue side effects first, then emit SSE last so listeners see the
  // status-change event after the data-consistency work has been kicked off.
  if (statusChanging) {
    fireAndForget(
      transitionSideEffectsService.onAdminForceUpdate({
        appointmentId,
        source: 'admin',
        adminId,
        appointment,
        previousStatus,
        newStatus: effectiveNewStatus as AppointmentStatus,
        skipNotifications,
        confirmedDateTime: confirmedDateTime ?? appointment.confirmedDateTime,
      }),
      appointmentId,
      'onAdminForceUpdate',
    );

    transitionSideEffectsService.notifyTransition(
      { success: true, previousStatus, newStatus: effectiveNewStatus as AppointmentStatus },
      appointmentId,
      'admin',
    );
  }

  logger.info(
    { ...logContext, previousStatus, newStatus: effectiveNewStatus, confirmedDateTime, reason, skipNotifications },
    'Appointment force-updated by admin (state machine bypassed)',
  );

  // Audit + Slack alert for visibility. Only the status-change case sends
  // a Slack alert (severity=high) — date-only edits are routine and would
  // be alert spam. Audit log fires for both so the bypass is always traceable.
  const isStatusChange = !!(newStatus && newStatus !== previousStatus);
  await recordAppointmentEvent({
    appointmentId,
    type: 'admin_force_update',
    actor: 'admin',
    reason,
    payload: {
      adminId,
      previousStatus,
      newStatus: effectiveNewStatus,
      confirmedDateTime,
      bypassedStateMachine: true,
    },
    ...(isStatusChange && {
      slack: {
        title: 'Admin force-updated appointment status (state machine bypassed)',
        severity: 'high',
        details:
          `An admin used the force-update path to change status from ` +
          `*${previousStatus}* to *${effectiveNewStatus}*, bypassing state machine ` +
          `validation. This path skips the normal lifecycle guards — ensure the ` +
          `outcome is correct.\n\nReason: ${reason}`,
        additionalFields: {
          'Admin': adminId,
          'Appointment': appointmentId,
        },
      },
    }),
  });

  return { success: true, previousStatus, newStatus: effectiveNewStatus as AppointmentStatus };
}
