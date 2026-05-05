/**
 * One-shot backfill: copy Notion therapist profile fields and Notion user
 * subscription status into the Postgres mirror columns added by the
 * 20260505_add_postgres_profile_mirror migration.
 *
 * Postgres is the future source of truth (PR 2 of the Notion deprecation
 * cuts reads over). This script makes Postgres ready by mirroring the data
 * that previously lived only in Notion: bio, categories, profileImage,
 * bookingLink, active flag for therapists, and the subscribed checkbox for
 * users.
 *
 * Idempotent — re-running upserts the same values. Safe to run multiple
 * times during cutover. Run with: npm run backfill:notion-to-postgres
 */

import { prisma } from '../utils/database';
import { logger } from '../utils/logger';
import { notionService } from '../services/notion.service';
import { notionUsersService } from '../services/notion-users.service';
import { getOrCreateTherapist, getOrCreateUser } from '../utils/unique-id';

interface BackfillStats {
  therapists: { processed: number; updated: number; created: number; failed: number };
  users: { processed: number; updated: number; created: number; failed: number };
}

async function backfillTherapists(): Promise<BackfillStats['therapists']> {
  const stats = { processed: 0, updated: 0, created: 0, failed: 0 };

  logger.info('Fetching all therapists from Notion');
  // fetchTherapists already filters to Active=true; for the mirror we want
  // every row, so we re-fetch through the raw Notion API. That said, inactive
  // rows in Notion shouldn't appear in the public listing — which is exactly
  // what `active=false` in Postgres will encode. For PR 1 we mirror the active
  // set; archived therapists will be picked up by an ops backfill later.
  const notionTherapists = await notionService.fetchTherapists();
  stats.processed = notionTherapists.length;

  for (const t of notionTherapists) {
    try {
      // Ensure the Postgres row exists (creates with odId if missing) — we
      // need its primary key before we can write profile columns.
      const existing = await prisma.therapist.findUnique({ where: { notionId: t.id } });

      if (!existing) {
        await getOrCreateTherapist(t.id, t.email, t.name);
        stats.created++;
      }

      // Write the profile mirror columns. Use updateMany with a notionId
      // filter so this handles both the just-created and already-existing
      // cases without a second roundtrip.
      const result = await prisma.therapist.updateMany({
        where: { notionId: t.id },
        data: {
          // Don't overwrite name/email here — they're handled by
          // getOrCreateTherapist on the create path and shouldn't be reset
          // from Notion if an admin has already corrected them in Postgres.
          bio: t.bio || null,
          approach: t.approach,
          style: t.style,
          areasOfFocus: t.areasOfFocus,
          profileImage: t.profileImage,
          bookingLink: t.bookingLink,
          active: t.active,
        },
      });

      if (result.count > 0 && existing) {
        stats.updated++;
      }
    } catch (err) {
      stats.failed++;
      logger.error({ err, notionId: t.id, name: t.name }, 'Failed to backfill therapist');
    }
  }

  logger.info(stats, 'Therapist backfill complete');
  return stats;
}

async function backfillUsers(): Promise<BackfillStats['users']> {
  const stats = { processed: 0, updated: 0, created: 0, failed: 0 };

  if (!notionUsersService.isConfigured()) {
    logger.warn('Notion users database not configured — skipping user backfill');
    return stats;
  }

  logger.info('Fetching all users from Notion');
  const notionUsers = await notionUsersService.fetchAllUsers();
  stats.processed = notionUsers.length;

  for (const u of notionUsers) {
    try {
      if (!u.email) {
        // Notion rows without an email can't be linked to Postgres — skip
        // rather than fail. These are typically draft rows or imports.
        continue;
      }

      const normalizedEmail = u.email.toLowerCase().trim();
      const existing = await prisma.user.findUnique({ where: { email: normalizedEmail } });

      if (!existing) {
        await getOrCreateUser(normalizedEmail, u.name);
        stats.created++;
      }

      // Mirror the subscribed flag. The migration set every existing row to
      // subscribed=true (matching Notion's opt-out default), so this only
      // changes anything for users who have explicitly unsubscribed in Notion.
      await prisma.user.update({
        where: { email: normalizedEmail },
        data: {
          subscribed: u.subscribed,
        },
      });

      if (existing) stats.updated++;
    } catch (err) {
      stats.failed++;
      logger.error({ err, email: u.email }, 'Failed to backfill user');
    }
  }

  logger.info(stats, 'User backfill complete');
  return stats;
}

async function main() {
  logger.info('Starting Notion → Postgres backfill');
  const start = Date.now();

  const therapists = await backfillTherapists();
  const users = await backfillUsers();

  const durationMs = Date.now() - start;
  logger.info({ therapists, users, durationMs }, 'Notion → Postgres backfill complete');
}

main()
  .catch((err) => {
    logger.error({ err }, 'Backfill script failed');
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
