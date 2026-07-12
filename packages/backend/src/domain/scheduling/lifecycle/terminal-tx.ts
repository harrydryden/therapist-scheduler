/**
 * Shared transactional skeleton for the terminal transitions (completed,
 * cancelled). Both follow the same pattern:
 *
 *   $transaction(serializable, 10s timeout):
 *     SELECT … FROM appointment_requests WHERE id = $id FOR UPDATE
 *     classify(row): idempotent | atomicSkipped | proceed | (throw to abort)
 *     UPDATE appointment_requests SET …
 *     INSERT INTO appointment_audit_events (status_change, …)
 *
 * Centralising it gives:
 *   - one place to tune isolation level / timeout / row-lock semantics;
 *   - guaranteed atomicity between the row update and the status_change
 *     audit event (both committed together or neither);
 *   - a single classify() callback that subsumes idempotent skip,
 *     atomic-precondition skip, and invalid-source-status throw.
 *
 * The caller controls the SELECT field list via `fetchAndLock` so each
 * transition only pulls the columns it actually dispatches on. The
 * returned outcome carries the same row, eliminating a second post-tx
 * round-trip.
 *
 * Throwing from `classify` rolls the transaction back — the audit event
 * row is never written for invalid transitions, so a forensic query for
 * "all status_change events" only reflects actual successful changes.
 *
 * Exported (module-scope) so unit tests can drive each branch with a
 * mocked $transaction without touching the service singleton.
 */

import { Prisma } from '@prisma/client';
import { prisma } from '../../../utils/database';
import { AppointmentNotFoundError } from '../../../errors';
import type { AppointmentStatus } from '../../../constants';
import type { TransitionSource } from './types';

export type TerminalTxOutcome<TRow> =
  | { kind: 'idempotent'; row: TRow; previousStatus: AppointmentStatus }
  | { kind: 'atomicSkipped'; row: TRow; previousStatus: AppointmentStatus }
  | { kind: 'success'; row: TRow; previousStatus: AppointmentStatus };

export interface RunTerminalTransitionTxArgs<
  TRow extends { id: string; status: string; transition_generation: number },
> {
  appointmentId: string;
  source: TransitionSource;
  adminId?: string;
  fetchAndLock: (tx: Prisma.TransactionClient) => Promise<TRow | null>;
  classify: (row: TRow) => 'idempotent' | 'atomicSkipped' | 'proceed';
  buildUpdateData: (row: TRow) => Prisma.AppointmentRequestUpdateInput;
  buildAuditPayload: (row: TRow) => Prisma.InputJsonObject;
  /**
   * Register durable side-effect intent rows atomically with the status
   * update, closing the crash window described in
   * docs/agent-harness-review/register-in-tx-design.md (finding #10): a
   * process death between commit and the post-commit fire-and-forget
   * dispatch used to leave zero durable trace that a notification was
   * ever due. Called after the audit event insert, still inside the
   * transaction. `postUpdateGeneration` is `row.transition_generation + 1`
   * (every `buildUpdateData` bumps `transitionGeneration` by exactly 1).
   *
   * Callers must register each row with the SAME idempotency-key inputs
   * (effect type + whether `transitionGeneration` is included) the
   * post-commit dispatch code uses for that effect type — otherwise the
   * post-commit call creates a second, duplicate row instead of finding
   * this one. See the per-effect-type generation table in the design doc.
   */
  registerEffects?: (
    tx: Prisma.TransactionClient,
    row: TRow,
    postUpdateGeneration: number,
  ) => Promise<void>;
}

export async function runTerminalTransitionTx<
  TRow extends { id: string; status: string; transition_generation: number },
>(args: RunTerminalTransitionTxArgs<TRow>): Promise<TerminalTxOutcome<TRow>> {
  return prisma.$transaction(
    async (tx) => {
      const row = await args.fetchAndLock(tx);
      if (!row) {
        throw new AppointmentNotFoundError(args.appointmentId);
      }
      const previousStatus = row.status as AppointmentStatus;
      const decision = args.classify(row);
      if (decision === 'idempotent') {
        return { kind: 'idempotent' as const, row, previousStatus };
      }
      if (decision === 'atomicSkipped') {
        return { kind: 'atomicSkipped' as const, row, previousStatus };
      }

      await tx.appointmentRequest.update({
        where: { id: args.appointmentId },
        data: args.buildUpdateData(row),
        select: { id: true },
      });

      await tx.appointmentAuditEvent.create({
        data: {
          appointmentRequestId: args.appointmentId,
          eventType: 'status_change',
          actor: args.source === 'admin' ? `admin:${args.adminId || 'unknown'}` : args.source,
          payload: args.buildAuditPayload(row),
        },
      });

      if (args.registerEffects) {
        await args.registerEffects(tx, row, row.transition_generation + 1);
      }

      return { kind: 'success' as const, row, previousStatus };
    },
    {
      // Serializable + FOR UPDATE — concurrent terminal transitions on
      // the same row serialize naturally; the second waiter sees the
      // committed state and either idempotent-skips or hits the
      // classify() guard. Brief unrelated writes (e.g. ai-conversation
      // state saves) hold the row lock for tens of ms; bounded by the
      // transaction timeout.
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      timeout: 10000,
    },
  );
}
