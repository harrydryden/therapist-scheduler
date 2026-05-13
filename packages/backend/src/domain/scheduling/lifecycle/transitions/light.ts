/**
 * "Light" transitions — those whose shape is a single atomic updateMany
 * with a status precondition and no extra row lock or reschedule logic.
 *
 *   contacted, negotiating, session_held, feedback_requested
 *
 * They share the `applyLightTransition` skeleton:
 *
 *   read current → idempotent skip → atomic updateMany with precondition
 *   → optional post-update hook (for paths that re-fire side effects when
 *     skipping a stage, e.g. confirmed → feedback_requested needs the
 *     onSessionHeld effects) → audit message + status_change event in
 *     parallel → notifyTransition (SSE).
 *
 * The heavy transitions (confirmed, completed, cancelled, adminForceUpdate)
 * have transactional row locks, reschedule logic, atomic options, or
 * skipNotifications and intentionally do NOT use this helper — collapsing
 * them in would force awkward branching.
 *
 * The read pulls `userEmail` alongside `id`/`status` so callers that need
 * to dispatch user-sync side effects in their `onAfterUpdate` hook don't
 * have to do a second round-trip. Methods that don't need it just ignore
 * the field.
 */

import { Prisma } from '@prisma/client';
import { prisma } from '../../../../utils/database';
import { logger } from '../../../../utils/logger';
import { APPOINTMENT_STATUS, type AppointmentStatus } from '../../../../constants';
import {
  AppointmentNotFoundError,
  InvalidTransitionError,
} from '../../../../errors';
import { addAuditMessage, recordStatusChangeEvent } from '../audit';
import {
  catchUpSessionHeldEffects,
  fireAndForget,
  notifyTransition,
} from '../dispatch-helpers';
import { transitionSideEffectsService } from '../../../../services/transition-side-effects.service';
import type {
  TransitionResult,
  TransitionSource,
  TransitionToContactedParams,
  TransitionToFeedbackRequestedParams,
  TransitionToNegotiatingParams,
  TransitionToSessionHeldParams,
} from '../types';

/**
 * Shared skeleton. `onAfterUpdate` runs after the atomic update succeeds
 * and before the audit writes; use it for side effects that need to
 * fire BEFORE the audit/SSE event.
 */
async function applyLightTransition(args: {
  appointmentId: string;
  source: TransitionSource;
  adminId?: string;
  targetStatus: AppointmentStatus;
  validFromStatuses: readonly AppointmentStatus[];
  /** Extra fields to write alongside status. */
  extraData?: Prisma.AppointmentRequestUpdateInput;
  buildAuditMessage: (previousStatus: AppointmentStatus) => string;
  /** Optional reason to embed in the status_change audit event payload. */
  auditReason?: string;
  onAfterUpdate?: (
    previousStatus: AppointmentStatus,
    appointment: { id: string; status: string; userEmail: string },
  ) => Promise<void> | void;
}): Promise<TransitionResult> {
  const {
    appointmentId,
    source,
    adminId,
    targetStatus,
    validFromStatuses,
    extraData,
    buildAuditMessage,
    auditReason,
    onAfterUpdate,
  } = args;
  const logContext = { appointmentId, source, adminId };

  const appointment = await prisma.appointmentRequest.findUnique({
    where: { id: appointmentId },
    select: { id: true, status: true, userEmail: true },
  });

  if (!appointment) {
    logger.error(logContext, `Cannot transition to ${targetStatus} - appointment not found`);
    throw new AppointmentNotFoundError(appointmentId);
  }

  const previousStatus = appointment.status as AppointmentStatus;

  if (previousStatus === targetStatus) {
    logger.debug(logContext, `Appointment already ${targetStatus} - skipping`);
    return { success: true, previousStatus, newStatus: targetStatus, skipped: true };
  }

  const updateResult = await prisma.appointmentRequest.updateMany({
    where: {
      id: appointmentId,
      status: { in: [...validFromStatuses] },
    },
    data: {
      status: targetStatus,
      lastActivityAt: new Date(),
      updatedAt: new Date(),
      // Bump generation atomically with the status flip so any side
      // effects keyed off this transition won't dedupe against prior
      // generations. Even light transitions (contacted, negotiating,
      // session_held, feedback_requested) get a unique generation so
      // callers like onSessionHeld don't have to know whether they
      // need versioning.
      transitionGeneration: { increment: 1 },
      ...extraData,
    },
  });

  if (updateResult.count === 0) {
    logger.warn(
      { ...logContext, currentStatus: previousStatus },
      `Invalid transition: ${previousStatus} → ${targetStatus}`,
    );
    throw new InvalidTransitionError(previousStatus, targetStatus);
  }

  if (onAfterUpdate) {
    await onAfterUpdate(previousStatus, appointment);
  }

  // Audit writes — independent, run in parallel.
  await Promise.all([
    addAuditMessage(appointmentId, source, buildAuditMessage(previousStatus), adminId),
    recordStatusChangeEvent(appointmentId, source, adminId, previousStatus, targetStatus, auditReason),
  ]);

  logger.info({ ...logContext, previousStatus }, `Appointment transitioned to ${targetStatus}`);

  const transition: TransitionResult = { success: true, previousStatus, newStatus: targetStatus };
  notifyTransition(transition, appointmentId, source);
  return transition;
}

/**
 * Transition: pending → contacted
 *
 * Called when the AI agent makes first contact with the user.
 */
export async function transitionToContacted(
  params: TransitionToContactedParams,
): Promise<TransitionResult> {
  const { appointmentId, source, adminId, hasAvailability } = params;
  return applyLightTransition({
    appointmentId,
    source,
    adminId,
    targetStatus: APPOINTMENT_STATUS.CONTACTED,
    validFromStatuses: [APPOINTMENT_STATUS.PENDING],
    buildAuditMessage: (prev) =>
      `Status changed: ${prev} → contacted (availability ${hasAvailability ? 'known' : 'unknown'})`,
    auditReason: `availability ${hasAvailability ? 'known' : 'unknown'}`,
  });
}

/**
 * Transition: contacted → negotiating
 *
 * Called when the user responds and negotiation begins.
 */
export async function transitionToNegotiating(
  params: TransitionToNegotiatingParams,
): Promise<TransitionResult> {
  const { appointmentId, source, adminId, notes } = params;
  return applyLightTransition({
    appointmentId,
    source,
    adminId,
    targetStatus: APPOINTMENT_STATUS.NEGOTIATING,
    validFromStatuses: [APPOINTMENT_STATUS.CONTACTED, APPOINTMENT_STATUS.PENDING],
    extraData: notes ? { notes } : undefined,
    buildAuditMessage: (prev) => `Status changed: ${prev} → negotiating`,
    auditReason: notes,
  });
}

/**
 * Transition: confirmed → session_held
 *
 * Called automatically by the periodic tick service when the session
 * datetime passes (with a one-hour buffer for sessions that run long).
 */
export async function transitionToSessionHeld(
  params: TransitionToSessionHeldParams,
): Promise<TransitionResult> {
  const { appointmentId, source, adminId } = params;
  return applyLightTransition({
    appointmentId,
    source,
    adminId,
    targetStatus: APPOINTMENT_STATUS.SESSION_HELD,
    validFromStatuses: [APPOINTMENT_STATUS.CONFIRMED],
    buildAuditMessage: (prev) => `Status changed: ${prev} → session_held`,
    onAfterUpdate: (_prev, apt) => {
      fireAndForget(
        transitionSideEffectsService.onSessionHeld({
          appointmentId,
          source,
          adminId,
          userEmail: apt.userEmail,
        }),
        appointmentId,
        'onSessionHeld',
      );
    },
  });
}

/**
 * Transition: session_held → feedback_requested (admin override allows
 * confirmed → feedback_requested for back-fill of legacy/admin-created
 * appointments that skipped the session_held window).
 *
 * Called when the feedback form email is sent.
 *
 * Rationale for the source-gated allowlist:
 * - System path (post-booking-followup tick): MUST come from
 *   session_held. Allowing confirmed here would race the lifecycle
 *   tick (which advances confirmed → session_held when the session
 *   datetime passes) and produce timing-dependent skips of the
 *   session_held audit event.
 * - Admin path: occasionally needs to back-fill feedback for an
 *   appointment that was confirmed but never auto-advanced (e.g. an
 *   external session that didn't have a parsed datetime). Admin
 *   keeps the wider allowlist.
 */
export async function transitionToFeedbackRequested(
  params: TransitionToFeedbackRequestedParams,
): Promise<TransitionResult> {
  const { appointmentId, source, adminId } = params;
  const validFromStatuses =
    source === 'admin'
      ? [APPOINTMENT_STATUS.SESSION_HELD, APPOINTMENT_STATUS.CONFIRMED]
      : [APPOINTMENT_STATUS.SESSION_HELD];
  return applyLightTransition({
    appointmentId,
    source,
    adminId,
    targetStatus: APPOINTMENT_STATUS.FEEDBACK_REQUESTED,
    validFromStatuses,
    extraData: { feedbackFormSentAt: new Date() },
    buildAuditMessage: (prev) => `Status changed: ${prev} → feedback_requested`,
    onAfterUpdate: (prev, apt) =>
      catchUpSessionHeldEffects(prev, {
        appointmentId,
        source,
        adminId,
        userEmail: apt.userEmail,
      }),
  });
}
