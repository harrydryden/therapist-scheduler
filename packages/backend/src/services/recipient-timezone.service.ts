/**
 * Resolve the IANA timezone an email recipient should see times in.
 *
 * Looks up the recipient by email — first as a User, then as a Therapist —
 * and derives their timezone via the same precedence the agent uses:
 *
 *   1. The explicit `timezone` column (populated by the booking agent
 *      after asking where they're based). Always wins when present.
 *   2. For therapists only: the legacy `availability.timezone` stamp.
 *   3. The country's default timezone for single-zone countries.
 *   4. Null — multi-zone country with no explicit zone on file.
 *
 * Returns null when the recipient can't be found OR when their country
 * has multiple timezones and we don't yet have an explicit zone.
 * Callers in the email-formatting path treat null as "I don't have a
 * confident local time" and fall back to the platform default (UK),
 * but the fallback now means "we genuinely don't know" rather than
 * "we never asked" — by the time a confirmation/reminder is being
 * sent, the booking agent will have had a chance to record the zone
 * via `record_user_timezone` / `record_therapist_timezone`.
 */

import { prisma } from '../utils/database';
import { logger } from '../utils/logger';
import { getDefaultTimezone } from '@therapist-scheduler/shared';

export async function resolveRecipientTimezone(email: string | null | undefined): Promise<string | null> {
  if (!email) return null;
  const normalized = email.toLowerCase().trim();
  if (!normalized) return null;

  try {
    // User lookup is the common case (clients book; therapists are fewer).
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
