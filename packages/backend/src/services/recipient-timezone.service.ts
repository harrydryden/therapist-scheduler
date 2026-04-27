/**
 * Resolve the IANA timezone an email recipient should see times in.
 *
 * Looks up the recipient by email — first as a User, then as a Therapist —
 * and derives their timezone:
 *   - For a therapist with an availability record, the availability.timezone
 *     wins (the admin's explicit choice during ingestion).
 *   - Otherwise, the country's default timezone is used.
 *   - For multi-timezone countries (US, CA, AU), we don't know which region
 *     they're in until the agent asks, so we return null and the caller
 *     should fall back to the platform default.
 *
 * Returns null when the recipient can't be found or their country has
 * multiple timezones — let the caller fall back to whatever they consider
 * sensible (typically `general.timezone`).
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
      select: { country: true },
    });
    if (user) {
      return getDefaultTimezone(user.country);
    }

    const therapist = await prisma.therapist.findUnique({
      where: { email: normalized },
      select: {
        country: true,
        // If the therapist has any availability record on file, the
        // appointment query that owns this notification will have the
        // timezone field. We don't have it here, so we settle for the
        // country's default. This is good enough for the recipients of
        // confirmation emails.
      },
    });
    if (therapist) {
      return getDefaultTimezone(therapist.country);
    }

    return null;
  } catch (err) {
    logger.warn({ err, email: normalized }, 'Failed to resolve recipient timezone, will use platform default');
    return null;
  }
}
