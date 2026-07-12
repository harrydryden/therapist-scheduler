/**
 * Atomic sentinel-claim helper for periodic services that operate on
 * an `appointmentRequest` row in three phases:
 *
 *   1. CLAIM   — flip a nullable timestamp field from `null` to the
 *                epoch sentinel (`new Date(0)`) iff still null.
 *                Other periodic-service ticks running concurrently see
 *                the sentinel and skip; the winner has exclusive
 *                ownership for as long as their tick takes.
 *   2. CONFIRM — flip the sentinel to the real "done" timestamp
 *                (typically `now()`), iff it's still our sentinel.
 *                Failure here means another writer raced ahead — the
 *                caller logs and bails.
 *   3. RELEASE — flip the sentinel back to `null` iff it's still our
 *                sentinel. Used on pre-send abort paths so the row
 *                can be re-evaluated next tick.
 *
 * Why an explicit helper instead of inline `prisma.X.updateMany`?
 *   - The `EPOCH_SENTINEL` constant is shared, eliminating the
 *     `new Date(0)` magic value scattered across services.
 *   - The contract is named: `tryClaimSentinel` / `confirmSentinelClaim`
 *     / `releaseSentinelClaim` reads better at the call site than
 *     `updateMany({ where: { id, X: null }, data: { X: new Date(0) }})`.
 *   - It's grep-able: searching for `tryClaimSentinel` finds every
 *     atomic-claim site in the codebase.
 *   - Tests for the helper cover the precondition logic once;
 *     callers don't each need to assert "we win when null" /
 *     "we lose when already claimed".
 *
 * Scope: this helper is intentionally narrow. Status-flip atomic
 * claims in `domain/scheduling/lifecycle` use a different shape
 * (status-set preconditions, multi-field bumps including the
 * generation counter) and are NOT migrated to this helper.
 */

import { Prisma } from '@prisma/client';
import { prisma } from './database';

/**
 * The "in-progress" sentinel used across all sentinel-claim sites.
 * Picked as Unix epoch because (a) it sorts before any real timestamp,
 * making it harmless to indexed range queries, and (b) it's
 * unambiguously "this is a sentinel, not a real send time".
 */
export const EPOCH_SENTINEL = new Date(0);

export type AppointmentSentinelField =
  | 'chaseSentAt'
  | 'reminderSentAt'
  | 'meetingLinkCheckSentAt'
  | 'feedbackFormSentAt'
  | 'feedbackReminderSentAt';

interface ClaimOptions {
  /**
   * Extra `where` clauses that must hold for the claim to succeed.
   * Use this for status preconditions (e.g. `status: 'confirmed'`)
   * so the claim aborts if the row drifts during the tick.
   */
  extraWhere?: Prisma.AppointmentRequestWhereInput;
}

interface ConfirmOptions {
  /**
   * Extra fields to write atomically with the sentinel-to-final flip.
   * Use this for partial-success markers (e.g. `isStale: true` when
   * one side of a multi-recipient send failed).
   */
  extraData?: Omit<Prisma.AppointmentRequestUpdateManyMutationInput, AppointmentSentinelField>;
}

/**
 * Try to claim the sentinel on `gateField` for the given appointment.
 * Returns true if we won the claim, false if another writer beat us
 * or the row drifted from the gate condition.
 *
 * The gate is `gateField === null` plus any caller-supplied
 * `extraWhere` clauses (e.g. `status: 'confirmed'`).
 */
export async function tryClaimSentinel(
  appointmentId: string,
  gateField: AppointmentSentinelField,
  options: ClaimOptions = {},
): Promise<boolean> {
  const result = await prisma.appointmentRequest.updateMany({
    where: {
      id: appointmentId,
      [gateField]: null,
      ...options.extraWhere,
    },
    data: {
      [gateField]: EPOCH_SENTINEL,
    },
  });
  return result.count > 0;
}

/**
 * Confirm a previously-claimed sentinel by flipping it to `finalValue`.
 * Returns true if the confirmation landed (gateField was still our
 * sentinel), false if another writer raced — the caller should log
 * and treat the side effect as already-handled.
 */
export async function confirmSentinelClaim(
  appointmentId: string,
  gateField: AppointmentSentinelField,
  finalValue: Date,
  options: ConfirmOptions = {},
): Promise<boolean> {
  const result = await prisma.appointmentRequest.updateMany({
    where: {
      id: appointmentId,
      [gateField]: EPOCH_SENTINEL,
    },
    data: {
      [gateField]: finalValue,
      ...options.extraData,
    },
  });
  return result.count > 0;
}

/**
 * Release a claimed sentinel back to `null` so the row can be re-
 * evaluated in the next tick. Used on pre-send abort paths
 * (e.g. when a thread sanity check finds an inbound reply we didn't
 * see in the candidate query). Returns true if the release landed.
 */
export async function releaseSentinelClaim(
  appointmentId: string,
  gateField: AppointmentSentinelField,
): Promise<boolean> {
  const result = await prisma.appointmentRequest.updateMany({
    where: {
      id: appointmentId,
      [gateField]: EPOCH_SENTINEL,
    },
    data: {
      [gateField]: null,
    },
  });
  return result.count > 0;
}

/**
 * Reset stuck sentinels — rows where `gateField` is still the EPOCH
 * sentinel (claimed but never confirmed/released) because the process
 * that claimed them crashed or was killed mid-tick before it could
 * confirm or release. Each periodic runner calls this once per tick,
 * before evaluating candidates, so a crash never permanently strands a
 * row past `olderThanMs`.
 *
 * Every caller previously hand-rolled this exact updateMany with an
 * inline `new Date(0)` literal for the sentinel value — consolidated
 * here so there's one place that defines "stuck" and one shared
 * implementation of the reset.
 *
 * Returns the reset count per field, so callers can log per-field
 * warnings exactly as before.
 */
export async function cleanupStuckSentinels(
  fields: readonly AppointmentSentinelField[],
  olderThanMs: number,
): Promise<Record<string, number>> {
  const cutoff = new Date(Date.now() - olderThanMs);
  const counts: Record<string, number> = {};

  const results = await Promise.all(
    fields.map((field) =>
      prisma.appointmentRequest.updateMany({
        where: { [field]: EPOCH_SENTINEL, updatedAt: { lt: cutoff } },
        data: { [field]: null },
      }),
    ),
  );

  fields.forEach((field, i) => {
    counts[field] = results[i].count;
  });

  return counts;
}
