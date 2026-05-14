/**
 * Backfill script — Phase 3a.
 *
 * Copies `conversationState` and `memory` from every existing
 * `appointment_requests` row into the corresponding
 * `appointment_conversations` row (created lazily).
 *
 * Idempotent: re-running is safe. Each pass:
 *   - skips rows already present in `appointment_conversations`
 *     UNLESS `--force-resync` is supplied (rebuilds every row);
 *   - never overwrites a NEWER `appointment_conversations` row with
 *     stale data from the legacy column (compares `updatedAt`).
 *
 * Run with:
 *   npx tsx src/scripts/backfill-appointment-conversation.ts
 *   npx tsx src/scripts/backfill-appointment-conversation.ts --force-resync
 *   npx tsx src/scripts/backfill-appointment-conversation.ts --verify
 *
 * The `--verify` mode runs a read-only divergence check: for every
 * appointment with a non-null legacy `conversationState`, asserts the
 * mirror row exists and the two JSON blobs are equal. Exit code 0
 * iff all rows match.
 *
 * Operational notes:
 *   - Processes in batches of 100 to avoid loading the full set
 *     into memory.
 *   - Logs progress every 100 rows so the operator can monitor.
 *   - On any per-row error, logs and continues. The error count is
 *     reported at the end and the script exits non-zero if > 0.
 */

import { Prisma } from '@prisma/client';
import { prisma } from '../utils/database';
import { logger } from '../utils/logger';

const BATCH_SIZE = 100;

interface BackfillResult {
  scanned: number;
  copied: number;
  skipped: number;
  errors: number;
}

interface VerifyResult {
  scanned: number;
  matching: number;
  missing: number;
  divergent: number;
  errors: number;
}

async function backfill(opts: { forceResync: boolean }): Promise<BackfillResult> {
  const result: BackfillResult = { scanned: 0, copied: 0, skipped: 0, errors: 0 };
  let cursor: string | undefined;

  while (true) {
    // Read in id-ordered batches so the cursor pattern is stable
    // across re-runs.
    const batch = await prisma.appointmentRequest.findMany({
      where: cursor ? { id: { gt: cursor } } : undefined,
      orderBy: { id: 'asc' },
      take: BATCH_SIZE,
      select: {
        id: true,
        conversationState: true,
        memory: true,
        updatedAt: true,
      },
    });

    if (batch.length === 0) break;
    cursor = batch[batch.length - 1].id;

    for (const row of batch) {
      result.scanned++;

      // Nothing to copy for rows that have neither field set. Skipping
      // these means we don't create empty mirror rows — the appointment
      // gets a mirror row the first time the agent writes to it.
      if (row.conversationState === null && row.memory === null) {
        result.skipped++;
        continue;
      }

      try {
        if (opts.forceResync) {
          await prisma.appointmentConversation.upsert({
            where: { appointmentId: row.id },
            create: {
              appointmentId: row.id,
              conversationState: row.conversationState as Prisma.InputJsonValue,
              memory: row.memory as Prisma.InputJsonValue,
            },
            update: {
              conversationState: row.conversationState as Prisma.InputJsonValue,
              memory: row.memory as Prisma.InputJsonValue,
            },
          });
          result.copied++;
        } else {
          // Only create — skip if the mirror row already exists. Avoids
          // overwriting newer dual-writes with stale legacy data.
          const existing = await prisma.appointmentConversation.findUnique({
            where: { appointmentId: row.id },
            select: { appointmentId: true },
          });
          if (existing) {
            result.skipped++;
            continue;
          }
          await prisma.appointmentConversation.create({
            data: {
              appointmentId: row.id,
              conversationState: row.conversationState as Prisma.InputJsonValue,
              memory: row.memory as Prisma.InputJsonValue,
            },
          });
          result.copied++;
        }
      } catch (err) {
        logger.error({ err, appointmentId: row.id }, 'backfill: failed to mirror row');
        result.errors++;
      }
    }

    logger.info(
      {
        scanned: result.scanned,
        copied: result.copied,
        skipped: result.skipped,
        errors: result.errors,
      },
      'backfill: progress',
    );
  }

  return result;
}

/**
 * Read-only verification. For every appointment with a non-null
 * legacy `conversationState`, asserts the mirror row exists and the
 * two JSON blobs are equal. Reports divergent rows by id.
 */
async function verify(): Promise<VerifyResult> {
  const result: VerifyResult = {
    scanned: 0,
    matching: 0,
    missing: 0,
    divergent: 0,
    errors: 0,
  };
  let cursor: string | undefined;

  while (true) {
    const batch = await prisma.appointmentRequest.findMany({
      where: cursor ? { id: { gt: cursor } } : undefined,
      orderBy: { id: 'asc' },
      take: BATCH_SIZE,
      select: {
        id: true,
        conversationState: true,
        memory: true,
      },
    });

    if (batch.length === 0) break;
    cursor = batch[batch.length - 1].id;

    for (const row of batch) {
      result.scanned++;

      // Rows with neither field set don't need a mirror.
      if (row.conversationState === null && row.memory === null) {
        result.matching++;
        continue;
      }

      try {
        const mirror = await prisma.appointmentConversation.findUnique({
          where: { appointmentId: row.id },
          select: { conversationState: true, memory: true },
        });

        if (!mirror) {
          result.missing++;
          logger.warn({ appointmentId: row.id }, 'verify: mirror row missing');
          continue;
        }

        const conversationMatches = jsonEqual(row.conversationState, mirror.conversationState);
        const memoryMatches = jsonEqual(row.memory, mirror.memory);

        if (conversationMatches && memoryMatches) {
          result.matching++;
        } else {
          result.divergent++;
          logger.warn(
            {
              appointmentId: row.id,
              conversationMatches,
              memoryMatches,
            },
            'verify: mirror diverges from legacy column',
          );
        }
      } catch (err) {
        logger.error({ err, appointmentId: row.id }, 'verify: error reading mirror row');
        result.errors++;
      }
    }
  }

  return result;
}

/**
 * Deep equality for the Prisma JSON shape. Both sides are either null
 * or `Prisma.JsonValue`. We canonical-stringify both sides so key
 * order in the legacy column doesn't produce false negatives — the
 * dual-write path serializes through JSON.stringify which doesn't
 * sort keys, but Postgres stores JSONB which DOES sort. Re-stringify
 * via JSON.parse(JSON.stringify(...)) normalises.
 */
function jsonEqual(a: Prisma.JsonValue | null, b: Prisma.JsonValue | null): boolean {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  // Both Prisma JsonValue — round-trip through JSON.parse so we get
  // value-equality regardless of original encoding quirks.
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

async function main() {
  const args = process.argv.slice(2);
  const isVerify = args.includes('--verify');
  const isForceResync = args.includes('--force-resync');

  if (isVerify) {
    logger.info('backfill: running in verify mode');
    const result = await verify();
    logger.info(result, 'backfill: verify complete');
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(result, null, 2));
    if (result.missing + result.divergent + result.errors > 0) {
      process.exit(1);
    }
    return;
  }

  logger.info({ forceResync: isForceResync }, 'backfill: starting');
  const result = await backfill({ forceResync: isForceResync });
  logger.info(result, 'backfill: complete');
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(result, null, 2));
  if (result.errors > 0) {
    process.exit(1);
  }
}

main()
  .catch((err) => {
    logger.error({ err }, 'backfill: fatal error');
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
