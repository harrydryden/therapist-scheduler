/**
 * Therapist + User Timezone Audit
 *
 * Scans every active therapist row AND every user row, classifies the
 * timezone state of each via the shared classifiers in
 * `src/core/timezone`, and prints a tab-
 * separated report. Optional `--apply` flag stamps the country default
 * on the safe subset:
 *
 *   - Therapist AUTO_FIXABLE rows: single-zone country, no
 *     `Therapist.timezone` column AND no `availability.timezone` —
 *     writes the country default to `Therapist.timezone`.
 *   - User AUTO_FIXABLE rows: single-zone country, no `User.timezone`
 *     — writes the country default to `User.timezone`.
 *
 * Multi-zone countries (US, Australia, Canada, ...) are NEVER auto-
 * corrected; only the agent (after asking the person) can do that via
 * record_therapist_timezone / record_user_timezone.
 *
 * Usage:
 *   npx ts-node scripts/audit-therapist-timezones.ts            # dry run
 *   npx ts-node scripts/audit-therapist-timezones.ts --apply    # apply AUTO_FIXABLE
 *
 * Or via the npm alias:
 *   npm run audit:therapist-timezones -- --apply
 *
 * Reads DATABASE_URL from env.
 */

import { PrismaClient } from '@prisma/client';
import {
  classifyTherapistTimezone,
  classifyUserTimezone,
  type TherapistTimezoneAuditRow,
  type TherapistTimezoneInput,
  type TimezoneClassification,
  type UserTimezoneAuditRow,
  type UserTimezoneInput,
} from '../src/core/timezone';

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const prisma = new PrismaClient();

  try {
    // ─── Therapists ──────────────────────────────────────────────────
    const therapists = (await prisma.therapist.findMany({
      where: { active: true },
      select: {
        id: true,
        name: true,
        email: true,
        country: true,
        timezone: true,
        availability: true,
      },
    })).map((t) => ({
      id: t.id,
      name: t.name,
      email: t.email,
      country: t.country,
      explicitTimezone: t.timezone,
      availability: t.availability as { timezone?: string } | null,
    })) as TherapistTimezoneInput[];

    const therapistReport: TherapistTimezoneAuditRow[] = therapists.map(classifyTherapistTimezone);
    const therapistBuckets: Record<TimezoneClassification, TherapistTimezoneAuditRow[]> = {
      OK: [],
      LEGACY_MISS_STAMP: [],
      AUTO_FIXABLE: [],
      SINGLE_ZONE_OVERRIDE: [],
      AMBIGUOUS: [],
      NO_SCHEDULE: [],
    };
    for (const r of therapistReport) therapistBuckets[r.classification].push(r);

    // ─── Users ────────────────────────────────────────────────────────
    const users = (await prisma.user.findMany({
      select: { id: true, name: true, email: true, country: true, timezone: true },
    })).map((u) => ({
      id: u.id,
      name: u.name,
      email: u.email,
      country: u.country,
      explicitTimezone: u.timezone,
    })) as UserTimezoneInput[];

    const userReport: UserTimezoneAuditRow[] = users.map(classifyUserTimezone);
    const userBuckets: Record<UserTimezoneAuditRow['classification'], UserTimezoneAuditRow[]> = {
      OK: [],
      AUTO_FIXABLE: [],
      AMBIGUOUS: [],
    };
    for (const r of userReport) userBuckets[r.classification].push(r);

    // ─── Report ──────────────────────────────────────────────────────
    console.log('# Timezone audit\n');
    console.log(`## Therapists (${therapists.length} active)`);
    for (const k of Object.keys(therapistBuckets) as TimezoneClassification[]) {
      console.log(`  ${k.padEnd(22)} ${therapistBuckets[k].length}`);
    }
    console.log('');

    console.log(`## Users (${users.length} total)`);
    for (const k of Object.keys(userBuckets) as Array<UserTimezoneAuditRow['classification']>) {
      console.log(`  ${k.padEnd(22)} ${userBuckets[k].length}`);
    }
    console.log('');

    console.log('## Therapist rows needing attention');
    console.log(['kind', 'id', 'name', 'email', 'country', 'current_tz', 'classification', 'suggested_fix'].join('\t'));
    for (const r of therapistReport) {
      if (r.classification === 'OK') continue;
      console.log(['therapist', r.id, r.name, r.email, r.country, r.currentTimezone, r.classification, r.suggestedFix].join('\t'));
    }

    console.log('\n## User rows needing attention');
    console.log(['kind', 'id', 'name', 'email', 'country', 'current_tz', 'classification', 'suggested_fix'].join('\t'));
    for (const r of userReport) {
      if (r.classification === 'OK') continue;
      console.log(['user', r.id, r.name, r.email, r.country, r.currentTimezone, r.classification, r.suggestedFix].join('\t'));
    }

    if (!apply) {
      console.log('\n(Dry run. Re-run with --apply to stamp the country default on AUTO_FIXABLE rows in BOTH tables.)');
      return;
    }

    // ─── Apply phase ─────────────────────────────────────────────────
    let appliedTherapists = 0;
    for (const r of therapistBuckets.AUTO_FIXABLE) {
      await prisma.therapist.update({
        where: { id: r.id },
        data: { timezone: r.suggestedFix },
      });
      console.log(`APPLIED therapist ${r.id}  ${r.email}  -> ${r.suggestedFix}`);
      appliedTherapists++;
    }
    let appliedUsers = 0;
    for (const r of userBuckets.AUTO_FIXABLE) {
      await prisma.user.update({
        where: { id: r.id },
        data: { timezone: r.suggestedFix },
      });
      console.log(`APPLIED user ${r.id}  ${r.email}  -> ${r.suggestedFix}`);
      appliedUsers++;
    }
    console.log(
      `\nApplied ${appliedTherapists} therapist fixes and ${appliedUsers} user fixes. LEGACY_MISS_STAMP / SINGLE_ZONE_OVERRIDE / AMBIGUOUS rows were NOT modified.`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
