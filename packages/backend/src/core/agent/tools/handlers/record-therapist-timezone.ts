/**
 * `record_therapist_timezone` — persist the therapist's IANA
 * timezone on their `Therapist.timezone` column.
 *
 * Legacy appointments without a `therapistId` can't be persisted
 * (no primary key to scope on). Same fallback as
 * `record_booking_link`.
 *
 * Validation: the IANA zone must be recognised by Intl. Unknown
 * strings are rejected with a specific error.
 */

import { logger } from '../../../../utils/logger';
import { prisma } from '../../../../utils/database';
import { recordTherapistTimezoneInputSchema } from '../../../../schemas/tool-inputs';
import { isValidIanaTimezone } from '../../../timezone';
import type {
  SchedulingContext,
  ToolExecutionResult,
} from '../../../../services/scheduling-context.service';

export async function handleRecordTherapistTimezone(
  rawInput: unknown,
  context: SchedulingContext,
  traceId: string,
): Promise<ToolExecutionResult> {
  const parsed = recordTherapistTimezoneInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    return {
      success: false,
      toolName: 'record_therapist_timezone',
      error: `Invalid record_therapist_timezone input: ${parsed.error.message}`,
    };
  }
  const { timezone } = parsed.data;
  if (!isValidIanaTimezone(timezone)) {
    return {
      success: false,
      toolName: 'record_therapist_timezone',
      error: `Unknown IANA timezone: "${timezone}". Pick a real zone — when in doubt, use one of the zones listed in the Timezones section above.`,
    };
  }
  if (!context.therapistId) {
    return {
      success: true,
      toolName: 'record_therapist_timezone',
      resultMessage: `Note: no therapistId on this legacy appointment; ${timezone} was not persisted to a Therapist record.`,
    };
  }
  const r = await prisma.therapist.updateMany({
    where: { id: context.therapistId },
    data: { timezone },
  });
  if (r.count === 0) {
    logger.warn(
      { traceId, therapistId: context.therapistId, timezone },
      'record_therapist_timezone: no therapist row matched — write was a no-op',
    );
    return {
      success: true,
      toolName: 'record_therapist_timezone',
      resultMessage: `Note: no Therapist row matched for ${context.therapistId}; the timezone was not persisted.`,
    };
  }
  logger.info(
    { traceId, therapistId: context.therapistId, timezone },
    'record_therapist_timezone: persisted therapist timezone',
  );
  return {
    success: true,
    toolName: 'record_therapist_timezone',
    resultMessage: `Recorded therapist timezone: ${timezone}.`,
  };
}
