/**
 * `mark_scheduling_complete` — confirm the booking and trigger
 * confirmation emails + Slack + therapist freeze.
 *
 * Two input shapes are accepted:
 *   1. Freeform `confirmed_datetime` string (legacy).
 *   2. Structured form (timezone + year/month/day/hour/minute).
 *      Synthesised into the freeform string via `resolveWallClock`,
 *      so DST / non-existent / unknown-timezone errors surface as
 *      specific tool errors the agent can react to.
 *
 * Delegates to `appointmentLifecycleService.transitionToConfirmed`
 * for the atomic confirmation. Reschedules (when the row is already
 * `confirmed`) flow through the same lifecycle path with
 * `reschedule.resetFollowUpFlags: true` so the new session gets a
 * fresh meeting-link check + reminder + feedback form.
 *
 * Defence in depth: re-reads `humanControlEnabled` before calling
 * the lifecycle service. The lifecycle service has its own atomic
 * gate via `atomic.requireHumanControlDisabled`, so this is belt-
 * and-braces.
 */

import { logger } from '../../../../utils/logger';
import { prisma } from '../../../../utils/database';
import { appointmentLifecycleService } from '../../../../domain/scheduling/lifecycle';
import { APPOINTMENT_STATUS } from '../../../../constants';
import type { AppointmentStatus } from '../../../../constants';
import {
  isValidIanaTimezone,
  resolveWallClock,
  formatIsoWithOffset,
} from '../../../timezone';
import { markCompleteInputSchema } from '../../../../schemas/tool-inputs';
import { availabilityResolver } from '../../../../domain/scheduling/availability/resolver';
import { parseConfirmedDateTime, areDatetimesEqual } from '../../../../utils/date';
import type { ConversationAction } from '../../../../services/conversation-checkpoint.service';
import type {
  SchedulingContext,
  ToolExecutionResult,
} from '../../../../services/scheduling-context.service';

export interface MarkSchedulingCompleteOutcome {
  result: ToolExecutionResult;
  checkpointAction?: ConversationAction;
}

export async function handleMarkSchedulingComplete(
  rawInput: unknown,
  context: SchedulingContext,
  traceId: string,
): Promise<MarkSchedulingCompleteOutcome> {
  const parsed = markCompleteInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const errorMsg = `Invalid mark_scheduling_complete input: ${parsed.error.message}`;
    logger.error({ traceId, errors: parsed.error.errors }, 'Invalid mark_scheduling_complete input');
    return { result: { success: false, toolName: 'mark_scheduling_complete', error: errorMsg } };
  }
  const completeData = parsed.data;

  // STEP 1: synthesise confirmed_datetime from the structured form when
  // the agent supplied one. Routes through the same resolveWallClock
  // path that resolve_local_time uses, so DST / non-existent /
  // unknown-timezone errors surface as specific tool errors. Legacy
  // callers passing the freeform `confirmed_datetime` string flow
  // through unchanged.
  let confirmedDateTime = completeData.confirmed_datetime;
  if (
    !confirmedDateTime &&
    completeData.timezone &&
    completeData.year !== undefined &&
    completeData.month !== undefined &&
    completeData.day !== undefined &&
    completeData.hour !== undefined &&
    completeData.minute !== undefined
  ) {
    if (!isValidIanaTimezone(completeData.timezone)) {
      return {
        result: {
          success: false,
          toolName: 'mark_scheduling_complete',
          error: `Unknown IANA timezone: "${completeData.timezone}". Pick a real zone.`,
        },
      };
    }
    const resolved = resolveWallClock(
      completeData.timezone,
      completeData.year,
      completeData.month - 1,
      completeData.day,
      completeData.hour,
      completeData.minute,
    );
    if (!resolved.ok) {
      return {
        result: {
          success: false,
          toolName: 'mark_scheduling_complete',
          error: `${resolved.error}: ${resolved.detail}`,
        },
      };
    }
    confirmedDateTime = formatIsoWithOffset(resolved.resolved);
    logger.info(
      { traceId, confirmedDateTime, structuredInput: completeData },
      'mark_scheduling_complete: synthesised confirmed_datetime from structured form',
    );
  }
  if (!confirmedDateTime) {
    // Shouldn't reach here — the Zod refine catches this — but
    // defensive in case the schema is relaxed.
    return {
      result: {
        success: false,
        toolName: 'mark_scheduling_complete',
        error: 'No confirmed_datetime provided and structured form is incomplete.',
      },
    };
  }

  // STEP 2: business-rule validation (date parseable, lead time, etc.).
  const validationError = await availabilityResolver.validateMarkComplete(confirmedDateTime);
  if (validationError) {
    logger.warn(
      { traceId, confirmedDateTime, error: validationError },
      'mark_scheduling_complete validation failed',
    );
    return {
      result: { success: false, toolName: 'mark_scheduling_complete', error: validationError },
    };
  }

  // STEP 3: confirm via the lifecycle service.
  await markComplete(context, { confirmed_datetime: confirmedDateTime, notes: completeData.notes }, traceId);

  return {
    result: { success: true, toolName: 'mark_scheduling_complete' },
    checkpointAction: 'sent_final_confirmations',
  };
}

async function markComplete(
  context: SchedulingContext,
  params: { confirmed_datetime: string; notes?: string },
  traceId: string,
): Promise<void> {
  logger.info(
    { traceId, appointmentRequestId: context.appointmentRequestId, params },
    'Marking scheduling complete via lifecycle service',
  );

  const existing = await prisma.appointmentRequest.findUnique({
    where: { id: context.appointmentRequestId },
    select: {
      status: true,
      confirmedDateTime: true,
      humanControlEnabled: true,
      reschedulingInProgress: true,
    },
  });

  // Defence in depth: re-check human control before critical operation.
  if (existing?.humanControlEnabled) {
    logger.info(
      { traceId, appointmentRequestId: context.appointmentRequestId },
      'Human control enabled - skipping markComplete',
    );
    return;
  }

  // Idempotency: if already confirmed with the same datetime, skip
  // duplicate processing. Semantic comparison handles variations like
  // "Monday 3rd" vs "Monday 3".
  if (
    existing?.status === 'confirmed' &&
    areDatetimesEqual(existing?.confirmedDateTime, params.confirmed_datetime)
  ) {
    logger.info(
      {
        traceId,
        appointmentRequestId: context.appointmentRequestId,
        existingDateTime: existing?.confirmedDateTime,
        newDateTime: params.confirmed_datetime,
      },
      'Appointment already confirmed with same datetime - skipping duplicate processing (idempotent)',
    );
    return;
  }

  const isReschedule = existing?.status === 'confirmed' && (existing?.confirmedDateTime || existing?.reschedulingInProgress);

  // Allowed source statuses:
  //   - For new confirmations: pending, contacted, negotiating
  //   - For reschedules: confirmed (with different datetime, or
  //     rescheduling after admin cleared date)
  const allowedFromStatuses: AppointmentStatus[] = isReschedule
    ? [APPOINTMENT_STATUS.CONFIRMED]
    : [APPOINTMENT_STATUS.PENDING, APPOINTMENT_STATUS.CONTACTED, APPOINTMENT_STATUS.NEGOTIATING];

  // Parse the confirmed datetime for post-booking follow-ups.
  //
  // Timezone interpretation: the platform scheduling timezone
  // (config.timezone, Europe/London), matching the Timezones prompt
  // section ("values passed to tools MUST be expressed in UK time"),
  // `validateMarkComplete` (which lead-time-checks the same string with
  // the platform default), and every downstream re-parse (post-booking
  // follow-ups, stale-check, admin routes). Parsing here in the USER's
  // timezone — as an earlier revision did — made the stored instant
  // disagree with the validated one by the full tz delta for non-UK
  // clients. Structured-form calls arrive as ISO-with-offset and are
  // timezone-unambiguous either way.
  const confirmedDateTimeParsed = parseConfirmedDateTime(params.confirmed_datetime);

  if (!confirmedDateTimeParsed) {
    logger.warn(
      { traceId, confirmedDateTime: params.confirmed_datetime },
      'Could not parse confirmed datetime - follow-up emails may not be sent automatically',
    );
  }

  const result = await appointmentLifecycleService.transitionToConfirmed({
    appointmentId: context.appointmentRequestId,
    confirmedDateTime: params.confirmed_datetime,
    confirmedDateTimeParsed,
    notes: params.notes,
    source: 'agent',
    sendEmails: true,
    atomic: {
      requireStatuses: allowedFromStatuses,
      requireHumanControlDisabled: true,
    },
    reschedule: isReschedule
      ? {
          previousConfirmedDateTime: existing.confirmedDateTime || undefined,
          resetFollowUpFlags: true,
        }
      : undefined,
  });

  if (result.atomicSkipped) {
    logger.info(
      {
        traceId,
        appointmentRequestId: context.appointmentRequestId,
        previousStatus: result.previousStatus,
      },
      'Appointment confirmation skipped atomically (human control or concurrent update)',
    );
    return;
  }

  if (result.skipped) {
    logger.info(
      { traceId, appointmentRequestId: context.appointmentRequestId },
      'Appointment confirmation skipped (idempotent)',
    );
    return;
  }

  // (status_change audit event is written by transitionToConfirmed)
  logger.info(
    { traceId, appointmentRequestId: context.appointmentRequestId, isReschedule },
    'Appointment confirmed via lifecycle service',
  );
}
