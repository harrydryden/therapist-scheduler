/**
 * Durable "this therapist has completed a session with this client" record
 * (`therapist_completed_clients`).
 *
 * The graduation rule — hide a therapist from the public finder once they
 * have completed sessions with `targetAppointments` distinct clients — used
 * to be computed live from `appointment_requests WHERE status='completed'`.
 * Retention hard-deletes completed rows after a year and admins can delete
 * them at any time, so a graduated therapist silently reappeared on the
 * finder (docs/SYSTEM_REVIEW_2026-09.md §3 #4). The rule now counts rows in
 * this table, which nothing ever deletes except the therapist's own
 * deletion (FK cascade).
 *
 * Written INSIDE the transaction that lands the appointment on `completed`
 * (transitions/completed.ts, admin-force.ts), so the status flip and the
 * record commit together or not at all. Idempotent: the table is unique on
 * (therapist_id, client_email_hash), so a repeat completion with the same
 * client — or a re-completion after an admin walk-back — is a no-op.
 *
 * Emails are stored as sha256(normalizeEmail(email)) hex — no PII. The
 * 20260928 consolidation migration seeded the table with the same hash of
 * lower(user_email) for every appointment already completed.
 */

import { createHash, randomUUID } from 'crypto';
import type { Prisma } from '@prisma/client';
import { logger } from '../../../utils/logger';
import { normalizeEmail } from '../../../utils/email-equals';

/** sha256 hex of the normalised (lowercased, trimmed) email. */
export function hashClientEmail(email: string): string {
  return createHash('sha256').update(normalizeEmail(email), 'utf8').digest('hex');
}

/**
 * Record that `userEmail` completed a session with the appointment's
 * therapist. `therapistId` is the appointment's FK; legacy rows that
 * predate the FK are resolved through the public handle (notionId for
 * Notion-era therapists, the Postgres id otherwise).
 *
 * Returns true when a row now exists for the pair (inserted or already
 * present), false when the therapist could not be resolved — logged, and
 * deliberately NOT thrown: an unresolvable legacy handle must not block the
 * completion itself (and such a therapist has no Therapist row for the
 * finder to list anyway).
 */
export async function recordCompletedClient(
  tx: Prisma.TransactionClient,
  args: {
    appointmentId: string;
    therapistId: string | null;
    therapistHandle: string | null;
    userEmail: string;
  },
): Promise<boolean> {
  const { appointmentId, therapistHandle, userEmail } = args;
  let therapistId = args.therapistId;

  if (!therapistId && therapistHandle) {
    const therapist = await tx.therapist.findFirst({
      where: { OR: [{ notionId: therapistHandle }, { id: therapistHandle }] },
      select: { id: true },
    });
    therapistId = therapist?.id ?? null;
  }

  if (!therapistId) {
    logger.warn(
      { appointmentId, therapistHandle },
      'Completed appointment has no resolvable therapist — completed-client record not written',
    );
    return false;
  }

  if (!normalizeEmail(userEmail)) {
    logger.warn({ appointmentId, therapistId }, 'Completed appointment has no client email — completed-client record not written');
    return false;
  }

  // ON CONFLICT DO NOTHING rather than a Prisma upsert: inside the
  // serializable completion transaction a unique violation would abort the
  // whole transaction, and a repeat completion with the same client is the
  // normal case, not an error.
  await tx.$executeRaw`
    INSERT INTO "therapist_completed_clients" ("id", "therapist_id", "client_email_hash", "completed_at")
    VALUES (${randomUUID()}, ${therapistId}, ${hashClientEmail(userEmail)}, NOW())
    ON CONFLICT ("therapist_id", "client_email_hash") DO NOTHING
  `;
  return true;
}
