/**
 * Therapist Timezone Audit
 *
 * Scans every active therapist row, classifies the
 * `availability.timezone` stamp via the shared classifier in
 * `src/services/therapist-timezone-audit.ts`, and prints a tab-
 * separated report. Optional `--apply` flag stamps the country default
 * on the narrow safe subset: AUTO_FIXABLE rows (single-zone country
 * with no stamp).
 *
 * Multi-zone countries (US, Australia, Canada, ...) are NEVER auto-
 * corrected because we don't know which region. They're flagged for
 * human review.
 *
 * Usage:
 *   npx ts-node scripts/audit-therapist-timezones.ts            # dry run
 *   npx ts-node scripts/audit-therapist-timezones.ts --apply    # apply AUTO_FIXABLE
 *
 * Or via the npm alias:
 *   npm run audit:therapist-timezones -- --apply
 *
 * Reads DATABASE_URL from env (whatever Prisma needs to connect).
 */

import { PrismaClient } from '@prisma/client';
import {
  classifyTherapistTimezone,
  type TherapistTimezoneAuditRow,
  type TherapistTimezoneInput,
  type TimezoneClassification,
} from '../src/services/therapist-timezone-audit';

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const prisma = new PrismaClient();

  try {
    const therapists = (await prisma.therapist.findMany({
      where: { active: true },
      select: { id: true, name: true, email: true, country: true, availability: true },
    })) as TherapistTimezoneInput[];

    const report: TherapistTimezoneAuditRow[] = therapists.map(classifyTherapistTimezone);
    const buckets: Record<TimezoneClassification, TherapistTimezoneAuditRow[]> = {
      OK: [],
      LEGACY_MISS_STAMP: [],
      AUTO_FIXABLE: [],
      SINGLE_ZONE_OVERRIDE: [],
      AMBIGUOUS: [],
      NO_SCHEDULE: [],
    };
    for (const r of report) buckets[r.classification].push(r);

    console.log('# Therapist timezone audit');
    console.log(`Scanned ${therapists.length} active therapists.\n`);
    console.log('## Summary');
    for (const k of Object.keys(buckets) as TimezoneClassification[]) {
      console.log(`  ${k.padEnd(22)} ${buckets[k].length}`);
    }
    console.log('');

    console.log('## Rows needing attention');
    console.log(
      ['id', 'name', 'email', 'country', 'current_tz', 'classification', 'suggested_fix'].join('\t'),
    );
    for (const r of report) {
      if (r.classification === 'OK') continue;
      console.log(
        [r.id, r.name, r.email, r.country, r.currentTimezone, r.classification, r.suggestedFix].join('\t'),
      );
    }

    if (!apply) {
      console.log('\n(Dry run. Re-run with --apply to stamp the country default on AUTO_FIXABLE rows.)');
      return;
    }

    let applied = 0;
    for (const r of buckets.AUTO_FIXABLE) {
      const therapist = therapists.find((t) => t.id === r.id);
      if (!therapist) continue;
      const existing = (therapist.availability ?? {}) as Record<string, unknown>;
      const next = { ...existing, timezone: r.suggestedFix };
      await prisma.therapist.update({
        where: { id: r.id },
        data: { availability: next as unknown as object },
      });
      console.log(`APPLIED  ${r.id}  ${r.email}  -> ${r.suggestedFix}`);
      applied++;
    }
    console.log(
      `\nApplied ${applied} fixes. LEGACY_MISS_STAMP / SINGLE_ZONE_OVERRIDE / AMBIGUOUS rows were NOT modified — please review manually.`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
