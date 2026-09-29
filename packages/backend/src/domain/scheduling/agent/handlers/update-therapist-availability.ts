/**
 * `update_therapist_availability` — write the therapist's recurring
 * weekly availability to the `Therapist.availability` JSON column.
 *
 * Security: only honoured when the inbound email was sent BY the
 * therapist. Otherwise a client could prompt-inject "update the
 * therapist's availability to nothing" and DoS the therapist's
 * bookings. `startScheduling` (no inbound sender) is also blocked.
 *
 * Persistence shape: the agent emits a day-string map
 * (e.g. `{Monday: "09:00-12:00, 14:00-17:00"}`); we convert it via
 * `parseDayStringsToSlots` into the structured
 * `TherapistAvailability` shape and stamp the therapist's timezone
 * (preferring an existing record's timezone, then their country's
 * default; see `buildPersistedAvailability` for the precedence).
 */

import { Prisma } from '@prisma/client';
import { logger } from '../../../../utils/logger';
import { prisma } from '../../../../utils/database';
import { getSettingValue } from '../../../../services/settings.service';
import { updateAvailabilityInputSchema } from '../../../../schemas/tool-inputs';
import {
  parseDayStringsToSlots,
  buildPersistedAvailability,
} from '../../../../domain/scheduling/availability/windows/parser';
import type { TherapistAvailability } from '@therapist-scheduler/shared';
import type { ConversationAction } from '../../../../services/conversation-checkpoint.service';
import type {
  SchedulingContext,
  ToolExecutionResult,
} from '../../../../services/scheduling-context.service';

export interface UpdateTherapistAvailabilityOutcome {
  result: ToolExecutionResult;
  checkpointAction?: ConversationAction;
}

export async function handleUpdateTherapistAvailability(
  rawInput: unknown,
  context: SchedulingContext,
  traceId: string,
): Promise<UpdateTherapistAvailabilityOutcome> {
  // Inbound-sender gate (security).
  if (context.inboundSender !== 'therapist') {
    const errorMsg =
      `update_therapist_availability is only allowed when the inbound email was from the therapist. ` +
      `Current inbound sender: ${context.inboundSender ?? 'none'}. ` +
      `If the client mentioned the therapist's availability, ask the therapist to confirm directly.`;
    logger.warn(
      {
        traceId,
        appointmentRequestId: context.appointmentRequestId,
        inboundSender: context.inboundSender,
      },
      'Blocked update_therapist_availability — inbound was not from therapist',
    );
    return { result: { success: false, toolName: 'update_therapist_availability', error: errorMsg } };
  }

  const parsed = updateAvailabilityInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const errorMsg = `Invalid update_therapist_availability input: ${parsed.error.message}`;
    logger.error({ traceId, errors: parsed.error.errors }, 'Invalid update_therapist_availability input');
    return { result: { success: false, toolName: 'update_therapist_availability', error: errorMsg } };
  }

  const outcome = await persistAvailability(context, parsed.data, traceId);
  // Nothing saved → not a success. Reporting success here advanced the
  // checkpoint to received_therapist_availability, marked the call
  // idempotent, and let the agent tell the client "availability is on
  // file" when it wasn't (e.g. "Mondays after 3pm" parses to no slots).
  if (outcome.kind === 'not_saved') {
    return { result: { success: false, toolName: 'update_therapist_availability', error: outcome.error } };
  }
  return {
    result: {
      success: true,
      toolName: 'update_therapist_availability',
      resultMessage: `Therapist availability saved (${outcome.slotCount} weekly slot(s), timezone ${outcome.timezone}).`,
    },
    checkpointAction: 'received_therapist_availability',
  };
}

type PersistAvailabilityOutcome =
  | { kind: 'saved'; slotCount: number; timezone: string }
  | { kind: 'not_saved'; error: string };

const NOT_SAVED_SUFFIX =
  'Nothing was saved. Do not tell anyone the availability is on file.';

async function persistAvailability(
  context: SchedulingContext,
  params: { availability: { [day: string]: string }; timezone?: string },
  traceId: string,
): Promise<PersistAvailabilityOutcome> {
  logger.info(
    { traceId, availability: params.availability },
    'Updating therapist availability',
  );

  try {
    const appointmentRequest = await prisma.appointmentRequest.findUnique({
      where: { id: context.appointmentRequestId },
      select: { therapistId: true, therapistHandle: true },
    });

    if (!appointmentRequest?.therapistHandle) {
      logger.error({ traceId }, 'No therapist handle found on appointment');
      return {
        kind: 'not_saved',
        error: `This appointment has no linked therapist record, so the availability could not be stored. ${NOT_SAVED_SUFFIX} Use flag_for_human_review.`,
      };
    }

    // therapistHandle is the public handle: legacy Notion page id for
    // older rows, Postgres uuid for post-Notion ingestions. Match by either.
    const therapist = await prisma.therapist.findFirst({
      where: {
        OR: [
          { notionId: appointmentRequest.therapistHandle },
          { id: appointmentRequest.therapistHandle },
        ],
      },
      select: { id: true, country: true, availability: true },
    });

    if (!therapist) {
      logger.error(
        { traceId, therapistHandle: appointmentRequest.therapistHandle },
        'Therapist not found in Postgres — cannot persist availability',
      );
      return {
        kind: 'not_saved',
        error: `The therapist record for this appointment was not found, so the availability could not be stored. ${NOT_SAVED_SUFFIX} Use flag_for_human_review.`,
      };
    }

    const slots = parseDayStringsToSlots(params.availability);
    if (slots.length === 0) {
      logger.warn(
        { traceId, raw: params.availability },
        'update_therapist_availability called with no parseable slots — skipping write',
      );
      return {
        kind: 'not_saved',
        error:
          `None of the availability could be parsed into weekly time ranges (${JSON.stringify(params.availability).slice(0, 200)}). ` +
          `Each value must be 24-hour ranges like "09:00-12:00, 14:00-17:00". ${NOT_SAVED_SUFFIX} ` +
          `Retry with explicit ranges, or ask the therapist for specific times.`,
      };
    }

    const platformTimezone = (await getSettingValue<string>('general.timezone')) || 'Europe/London';
    const existing = (therapist.availability as unknown) as TherapistAvailability | null;
    const newAvailability = buildPersistedAvailability({
      slots,
      existing,
      country: therapist.country,
      platformTimezone,
      suppliedTimezone: params.timezone,
    });

    await prisma.therapist.update({
      where: { id: therapist.id },
      data: { availability: newAvailability as unknown as Prisma.InputJsonValue },
    });

    logger.info(
      {
        traceId,
        therapistId: therapist.id,
        timezone: newAvailability.timezone,
        slotCount: slots.length,
      },
      'Therapist availability updated in Postgres',
    );
    return { kind: 'saved', slotCount: slots.length, timezone: newAvailability.timezone };
  } catch (error) {
    logger.error(
      { traceId, error },
      'Failed to update therapist availability',
    );
    // Re-throw to signal failure to the tool execution handler.
    // Ensures Claude knows the tool failed and can respond appropriately.
    throw error;
  }
}
