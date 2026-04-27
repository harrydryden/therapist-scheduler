/**
 * Backfill script: copy therapist availability from Notion's per-day
 * rich_text columns into the Postgres `Therapist.availability` JSON column.
 *
 * Postgres is now the source of truth for availability. Existing therapists
 * who were ingested via the old flow have their availability sitting in
 * Notion's Monday/Tuesday/.../Sunday rich_text columns; this script reads
 * those columns directly (bypassing the now-stripped notion.service mapping)
 * and writes them into Postgres so nothing is lost during the cutover.
 *
 * Idempotent — therapists that already have a Postgres availability record
 * are skipped, so re-running is safe. Therapists with no Notion availability
 * are left untouched.
 *
 * Run with: npx ts-node src/scripts/backfill-therapist-availability.ts
 * Or via npm script: npm run backfill:therapist-availability
 */

import { Client } from '@notionhq/client';
import { Prisma } from '@prisma/client';
import { config } from '../config';
import { prisma } from '../utils/database';
import { logger } from '../utils/logger';
import { getDefaultTimezone } from '@therapist-scheduler/shared';
import type { TherapistAvailability, AvailabilitySlot } from '@therapist-scheduler/shared';

const notion = new Client({ auth: config.notionApiKey });

const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] as const;

/**
 * Read a single therapist's availability from the Notion page properties.
 * Returns null if no day columns are populated.
 */
async function readNotionAvailability(notionId: string): Promise<AvailabilitySlot[]> {
  const page = await notion.pages.retrieve({ page_id: notionId });
  const properties = (page as any).properties || {};

  const slots: AvailabilitySlot[] = [];
  for (const day of DAY_NAMES) {
    const dayProperty = properties[day];
    const dayText: string | undefined = dayProperty?.rich_text?.[0]?.plain_text?.trim();
    if (!dayText) continue;

    for (const range of dayText.split(',').map((s: string) => s.trim())) {
      const match = range.match(/^(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})$/);
      if (match) {
        slots.push({ day, start: match[1], end: match[2] });
      }
    }
  }
  return slots;
}

async function main() {
  logger.info('Starting therapist availability backfill from Notion → Postgres');

  const therapists = await prisma.therapist.findMany({
    select: { id: true, notionId: true, name: true, country: true, availability: true },
  });

  let updated = 0;
  let skippedExisting = 0;
  let skippedEmpty = 0;
  let failed = 0;

  for (const t of therapists) {
    if (t.availability) {
      skippedExisting++;
      continue;
    }

    try {
      const slots = await readNotionAvailability(t.notionId);
      if (slots.length === 0) {
        skippedEmpty++;
        continue;
      }

      // Stamp the timezone from the therapist's country (single-tz countries
      // get their own zone; multi-tz fall back to the platform timezone).
      const timezone = getDefaultTimezone(t.country) || config.timezone;

      const availability: TherapistAvailability = { timezone, slots };
      await prisma.therapist.update({
        where: { id: t.id },
        data: { availability: availability as unknown as Prisma.InputJsonValue },
      });
      updated++;
      logger.info({ therapistId: t.id, name: t.name, slotCount: slots.length, timezone }, 'Backfilled availability');
    } catch (err) {
      failed++;
      logger.error({ err, therapistId: t.id, notionId: t.notionId }, 'Failed to backfill availability');
    }
  }

  logger.info(
    { total: therapists.length, updated, skippedExisting, skippedEmpty, failed },
    'Therapist availability backfill complete',
  );
}

main()
  .catch((err) => {
    logger.error({ err }, 'Backfill script failed');
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
