/**
 * `record_booking_link` — capture the therapist's direct booking
 * link (Calendly, Acuity, etc.) on their permanent record.
 *
 * Legacy appointments without a `therapistId` can't be persisted
 * (no primary key to scope on). For those we return success but
 * with a note that the link wasn't stored — the agent can still
 * relay the URL to the client.
 */

import { recordBookingLinkInputSchema } from '../../../../schemas/tool-inputs';
import { recordTherapistBookingLink } from '../../../../domain/scheduling/availability/windows/therapist-store';
import type {
  SchedulingContext,
  ToolExecutionResult,
} from '../../../../services/scheduling-context.service';

export async function handleRecordBookingLink(
  rawInput: unknown,
  context: SchedulingContext,
): Promise<ToolExecutionResult> {
  const parsed = recordBookingLinkInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    return {
      success: false,
      toolName: 'record_booking_link',
      error: `Invalid record_booking_link input: ${parsed.error.message}`,
    };
  }
  if (!context.therapistId) {
    // Legacy appointment without a therapistId — no primary key to
    // scope the write on. Forward to the client (existing email
    // flow handles that) but don't persist.
    return {
      success: true,
      toolName: 'record_booking_link',
      resultMessage:
        'Booking link noted but not persisted (legacy appointment without a linked therapist row).',
      // Informational: see ToolExecutionResult docstring.
      bypassPostSuccessBookkeeping: true,
    };
  }
  try {
    await recordTherapistBookingLink(context.therapistId, parsed.data.url);
    return {
      success: true,
      toolName: 'record_booking_link',
      resultMessage: `Booking link recorded on therapist record: ${parsed.data.url}`,
      // Informational: most-recent-write wins at the storage layer.
      // See ToolExecutionResult docstring.
      bypassPostSuccessBookkeeping: true,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, toolName: 'record_booking_link', error: msg };
  }
}
