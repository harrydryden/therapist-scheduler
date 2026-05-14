/**
 * `record_user_timezone` — persist the user's IANA timezone on
 * their `User.timezone` column.
 *
 * Scope: prefer `userId` when present (covers cases where the user
 * has multiple email aliases on file); fall back to email-keyed
 * update for legacy rows. `updateMany` is used either way so a
 * missing row is a no-op rather than a throw — some clients don't
 * have a User record yet at the time the agent learns their timezone.
 *
 * Validation: the IANA zone string must be recognised by Intl.
 * Unknown strings (e.g. "America/Atlantis") are rejected with a
 * specific error the agent can re-prompt around.
 */

import { logger } from '../../../../utils/logger';
import { prisma } from '../../../../utils/database';
import { recordUserTimezoneInputSchema } from '../../../../schemas/tool-inputs';
import { isValidIanaTimezone } from '../../../timezone';
import type {
  SchedulingContext,
  ToolExecutionResult,
} from '../../../../services/scheduling-context.service';

export async function handleRecordUserTimezone(
  rawInput: unknown,
  context: SchedulingContext,
  traceId: string,
): Promise<ToolExecutionResult> {
  const parsed = recordUserTimezoneInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    return {
      success: false,
      toolName: 'record_user_timezone',
      error: `Invalid record_user_timezone input: ${parsed.error.message}`,
    };
  }
  const { timezone } = parsed.data;
  if (!isValidIanaTimezone(timezone)) {
    return {
      success: false,
      toolName: 'record_user_timezone',
      error: `Unknown IANA timezone: "${timezone}". Pick a real zone — when in doubt, use one of the zones listed in the Timezones section above.`,
    };
  }
  let updatedCount = 0;
  if (context.userId) {
    const r = await prisma.user.updateMany({
      where: { id: context.userId },
      data: { timezone },
    });
    updatedCount = r.count;
  } else if (context.userEmail) {
    const r = await prisma.user.updateMany({
      where: { email: context.userEmail.toLowerCase() },
      data: { timezone },
    });
    updatedCount = r.count;
  }
  if (updatedCount === 0) {
    logger.warn(
      { traceId, userId: context.userId, userEmail: context.userEmail, timezone },
      'record_user_timezone: no user row matched — write was a no-op',
    );
    return {
      success: true,
      toolName: 'record_user_timezone',
      resultMessage: `Note: no User row matched for ${context.userEmail}; the timezone was not persisted (client may not have a User record yet).`,
      // Informational: see ToolExecutionResult docstring.
      bypassPostSuccessBookkeeping: true,
    };
  }
  logger.info(
    { traceId, userId: context.userId, userEmail: context.userEmail, timezone },
    'record_user_timezone: persisted client timezone',
  );
  return {
    success: true,
    toolName: 'record_user_timezone',
    resultMessage: `Recorded client timezone: ${timezone}.`,
    // Informational: a corrected timezone might be re-recorded mid-
    // conversation if the user clarifies their location. Don't burn
    // ceiling budget on it. See ToolExecutionResult docstring.
    bypassPostSuccessBookkeeping: true,
  };
}
