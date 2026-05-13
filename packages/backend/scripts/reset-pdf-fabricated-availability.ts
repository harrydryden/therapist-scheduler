/**
 * Reset PDF-Fabricated Therapist.availability
 *
 * Background: an earlier version of `services/pdf-ingestion.service.ts` showed
 * the extraction LLM a literal example slot ({"day":"Monday","start":"09:00",
 * "end":"17:00"}) inside the JSON schema. When the source PDF didn't state
 * working hours, the model copied the example (or made up a similar pattern)
 * instead of returning null. The result: a population of newly-ingested
 * therapists with plausible-looking but fabricated 9-5 weekday schedules
 * stamped into `Therapist.availability`.
 *
 * Detection heuristic: `Therapist.availability` was set, but the availability-
 * collection agent has not yet recorded anything in
 * `Therapist.upcomingAvailability`. The agent is the source of truth — once it
 * has collected windows, the therapist has been through the real flow and
 * the recurring schedule on file may have been confirmed too. If
 * `upcomingAvailability` is empty/null, the recurring value is either still
 * the PDF-stamped guess or hasn't been touched since ingestion.
 *
 * Usage:
 *   npx ts-node scripts/reset-pdf-fabricated-availability.ts            # dry run
 *   npx ts-node scripts/reset-pdf-fabricated-availability.ts --apply    # null out the RESETTABLE rows
 *   npx ts-node scripts/reset-pdf-fabricated-availability.ts --id <id>  # inspect a single therapist
 *
 * Reads DATABASE_URL from env. After running, the availability-collection
 * agent will re-ask each affected therapist as part of normal onboarding /
 * nudge flow.
 */

import { PrismaClient } from '@prisma/client';
import { parseWindows } from '../src/domain/scheduling/availability/windows/store';

interface Row {
  id: string;
  name: string;
  email: string;
  country: string | null;
  availability: unknown;
  upcomingAvailability: unknown;
}

type Status = 'RESETTABLE' | 'KEEP_AGENT_CONFIRMED' | 'ALREADY_NULL';

function classify(row: Row): Status {
  if (row.availability === null || row.availability === undefined) return 'ALREADY_NULL';
  const windows = parseWindows(row.upcomingAvailability);
  if (windows.length > 0) return 'KEEP_AGENT_CONFIRMED';
  return 'RESETTABLE';
}

function summariseSlots(availability: unknown): string {
  if (!availability || typeof availability !== 'object') return '-';
  const slots = (availability as { slots?: unknown }).slots;
  if (!Array.isArray(slots) || slots.length === 0) return 'no slots';
  return slots
    .map((s) => {
      if (!s || typeof s !== 'object') return '?';
      const r = s as { day?: string; start?: string; end?: string };
      return `${r.day ?? '?'} ${r.start ?? '?'}-${r.end ?? '?'}`;
    })
    .join('; ');
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const idArgIndex = process.argv.indexOf('--id');
  const targetId = idArgIndex >= 0 ? process.argv[idArgIndex + 1] : null;

  const prisma = new PrismaClient();

  try {
    const therapists: Row[] = await prisma.therapist.findMany({
      where: {
        active: true,
        ...(targetId ? { id: targetId } : {}),
      },
      select: {
        id: true,
        name: true,
        email: true,
        country: true,
        availability: true,
        upcomingAvailability: true,
      },
      orderBy: { name: 'asc' },
    });

    const classified = therapists.map((t) => ({ row: t, status: classify(t) }));

    const counts = {
      RESETTABLE: 0,
      KEEP_AGENT_CONFIRMED: 0,
      ALREADY_NULL: 0,
    } as Record<Status, number>;
    for (const c of classified) counts[c.status]++;

    process.stdout.write(`status\tid\tname\tcountry\tslots\n`);
    for (const { row, status } of classified) {
      if (status === 'ALREADY_NULL') continue;
      process.stdout.write(
        `${status}\t${row.id}\t${row.name}\t${row.country ?? '-'}\t${summariseSlots(row.availability)}\n`,
      );
    }

    process.stderr.write(`\n${'-'.repeat(60)}\n`);
    process.stderr.write(`Total active therapists: ${therapists.length}\n`);
    process.stderr.write(`  ALREADY_NULL:          ${counts.ALREADY_NULL}\n`);
    process.stderr.write(`  KEEP_AGENT_CONFIRMED:  ${counts.KEEP_AGENT_CONFIRMED}\n`);
    process.stderr.write(`  RESETTABLE:            ${counts.RESETTABLE}\n`);
    process.stderr.write(`${'-'.repeat(60)}\n`);

    if (!apply) {
      process.stderr.write(
        `\nDry run. Re-run with --apply to NULL the RESETTABLE rows.\n`,
      );
      return;
    }

    if (counts.RESETTABLE === 0) {
      process.stderr.write(`\nNothing to reset.\n`);
      return;
    }

    const ids = classified.filter((c) => c.status === 'RESETTABLE').map((c) => c.row.id);
    const result = await prisma.therapist.updateMany({
      where: { id: { in: ids } },
      data: { availability: { set: null } },
    });
    process.stderr.write(`\nReset availability on ${result.count} therapist row(s).\n`);
    process.stderr.write(
      `The availability-collection agent will re-ask each via the normal nudge flow.\n`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  process.stderr.write(`\nFailed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
