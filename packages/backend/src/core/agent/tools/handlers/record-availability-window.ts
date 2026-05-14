/**
 * `record_availability_window` — capture an episodic availability
 * window mentioned in conversation. Distinct from the recurring
 * weekly base availability set by `update_therapist_availability`.
 *
 * Routing:
 *   - source='therapist' (with a linked therapistId) → per-therapist
 *     `Therapist.upcomingAvailability` JSON column. Every future
 *     booking sees these windows via system-prompt-builder.
 *   - source='user', or therapist-source without a therapistId →
 *     per-appointment `AppointmentRequest.memory.availabilityWindows`.
 *     A user's "I'm out next week" only applies to THIS booking.
 *
 * Security: source='therapist' is only honoured when the inbound
 * email was sent BY the therapist. Otherwise a client could
 * prompt-inject "the therapist is free Tuesdays" and pollute the
 * therapist's permanent record. When the agent tries this on a
 * user-inbound, we silently downgrade the source to 'user' (per-
 * appointment storage) and log a warn so the pattern is visible.
 * We don't return an error because the agent is sometimes confused
 * about source attribution and forcing a retry doesn't help.
 *
 * Validation:
 *   - endsAt strictly after startsAt
 *   - endsAt strictly after now (no purely past windows — almost
 *     always a date-resolution bug)
 */

import { logger } from '../../../../utils/logger';
import { recordAvailabilityWindowInputSchema } from '../../../../schemas/tool-inputs';
import { addUpcomingAvailability } from '../../../../domain/scheduling/availability/windows/therapist-store';
import { addAvailabilityWindow } from '../../../../services/agent-memory.service';
import type {
  SchedulingContext,
  ToolExecutionResult,
} from '../../../../services/scheduling-context.service';

export async function handleRecordAvailabilityWindow(
  rawInput: unknown,
  context: SchedulingContext,
  traceId: string,
): Promise<ToolExecutionResult> {
  const parsed = recordAvailabilityWindowInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    return {
      success: false,
      toolName: 'record_availability_window',
      error: `Invalid record_availability_window input: ${parsed.error.message}`,
    };
  }

  const startMs = Date.parse(parsed.data.starts_at);
  const endMs = Date.parse(parsed.data.ends_at);
  if (endMs <= startMs) {
    return {
      success: false,
      toolName: 'record_availability_window',
      error: 'ends_at must be strictly after starts_at',
    };
  }

  // Reject windows that have already passed entirely. The agent
  // sometimes resolves "Friday" to the wrong Friday — a window
  // ending in the past is almost always a date-resolution bug and
  // storing it would mislead later turns.
  if (endMs <= Date.now()) {
    return {
      success: false,
      toolName: 'record_availability_window',
      error:
        'ends_at is already in the past — this window has no future value. ' +
        'If you intended to record a future window, re-check the date you computed (perhaps "next Friday" needed +7 days).',
    };
  }

  // Security: source='therapist' writes to the per-therapist
  // permanent store. Only honoured when inbound is from therapist.
  let effectiveSource = parsed.data.source;
  if (parsed.data.source === 'therapist' && context.inboundSender !== 'therapist') {
    logger.warn(
      {
        traceId,
        appointmentRequestId: context.appointmentRequestId,
        inboundSender: context.inboundSender,
        attemptedSource: 'therapist',
        quote: parsed.data.quote,
      },
      'record_availability_window: downgrading source from therapist to user — inbound was not from therapist',
    );
    effectiveSource = 'user';
  }

  try {
    // Routing: therapist-source windows go to per-therapist store
    // (read by booking agent's prompt builder). User-source windows
    // stay per-appointment.
    //
    // Legacy appointments missing context.therapistId fall back to
    // per-appointment for both sources — the per-therapist write
    // would have no primary key to scope on.
    const isTherapistSource = effectiveSource === 'therapist' && !!context.therapistId;

    if (isTherapistSource) {
      const result = await addUpcomingAvailability(context.therapistId!, {
        startsAt: parsed.data.starts_at,
        endsAt: parsed.data.ends_at,
        status: parsed.data.status,
        source: 'therapist',
        quote: parsed.data.quote,
      });
      return {
        success: true,
        toolName: 'record_availability_window',
        resultMessage: result.added
          ? `Therapist availability window recorded on permanent record (id: ${result.windowId}, status: ${parsed.data.status}). Total upcoming windows: ${result.windows.length}.`
          : `Therapist availability window already present (id: ${result.windowId}). Skipped duplicate.`,
        // Informational: window storage already dedups by content
        // hash. The agent may legitimately record many windows
        // across one conversation. See ToolExecutionResult docstring.
        bypassPostSuccessBookkeeping: true,
      };
    }

    const result = await addAvailabilityWindow(context.appointmentRequestId, {
      startsAt: parsed.data.starts_at,
      endsAt: parsed.data.ends_at,
      status: parsed.data.status,
      source: effectiveSource,
      quote: parsed.data.quote,
    });
    return {
      success: true,
      toolName: 'record_availability_window',
      resultMessage: result.added
        ? `Availability window recorded for this booking (id: ${result.windowId}, status: ${parsed.data.status}, source: ${effectiveSource}). Total active windows: ${result.memory.availabilityWindows.length}.`
        : `Availability window already present (id: ${result.windowId}). Skipped duplicate.`,
      // Informational — see therapist-source branch above.
      bypassPostSuccessBookkeeping: true,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, toolName: 'record_availability_window', error: msg };
  }
}
