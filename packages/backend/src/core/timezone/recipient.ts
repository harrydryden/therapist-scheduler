/**
 * DB-backed recipient timezone lookup.
 *
 * Separated from the pure resolvers in `./resolve.ts` so importing
 * the timezone barrel from a test-only or no-DB code path (e.g. the
 * wall-clock unit tests) doesn't transitively pull in Prisma and the
 * runtime config validator.
 *
 * The function looks the address up as a User first, then a
 * Therapist, and runs the same precedence chain the pure resolvers
 * use (`explicit` → `stamped` (therapists) → country default → null).
 *
 * Returns null when:
 *   - the address doesn't match a row, OR
 *   - the row's country is multi-zone and there's nothing explicit on
 *     file yet.
 *
 * Outbound-email callers treat null as "I don't have a confident
 * local time" and fall back to the platform default — by the time a
 * confirmation/reminder is being sent, the booking agent will have
 * had a chance to record the zone via `record_user_timezone` /
 * `record_therapist_timezone`.
 */

import { getDefaultTimezone } from '@therapist-scheduler/shared';
import { prisma } from '../../utils/database';
import { logger } from '../../utils/logger';

export async function resolveRecipientTimezone(email: string | null | undefined): Promise<string | null> {
  if (!email) return null;
  const normalized = email.toLowerCase().trim();
  if (!normalized) return null;

  try {
    const user = await prisma.user.findUnique({
      where: { email: normalized },
      select: { country: true, timezone: true },
    });
    if (user) {
      if (user.timezone) return user.timezone;
      return getDefaultTimezone(user.country);
    }

    const therapist = await prisma.therapist.findUnique({
      where: { email: normalized },
      select: { country: true, timezone: true, availability: true },
    });
    if (therapist) {
      if (therapist.timezone) return therapist.timezone;
      const stamped = (therapist.availability as { timezone?: string } | null)?.timezone;
      if (stamped) return stamped;
      return getDefaultTimezone(therapist.country);
    }

    return null;
  } catch (err) {
    logger.warn({ err, email: normalized }, 'Failed to resolve recipient timezone, will use platform default');
    return null;
  }
}
