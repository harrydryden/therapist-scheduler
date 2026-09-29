/**
 * Side Effect Tracker Service — Data Layer
 *
 * Owns the `side_effect_logs` table: registration, lifecycle
 * (completed / failed / abandoned), idempotency-key generation, retry
 * candidate queries, stats, cleanup.
 *
 * Higher-level orchestration (binding tracked-side-effect semantics to
 * runBackgroundTask, render-then-register sequencing, scope dispatch)
 * lives in side-effect-harness.ts. The retry runner lives in
 * side-effect-retry.service.ts.
 *
 * Two-phase commit pattern: an effect is registered BEFORE it executes,
 * then marked completed/failed AFTER. A row that's stuck in `pending`
 * (or recently `failed`) gets picked up by the retry runner on its
 * periodic tick, so transient outages don't drop side effects.
 *
 * Usage:
 * 1. Before executing side effects, register them with registerSideEffects()
 * 2. Claim the execute lease with tryClaimEffect() — it returns the lease
 *    token (the `lastAttempt` it stamped) or null if another worker holds it
 * 3. Execute, then call markCompleted()/markFailed() WITH that lease. The
 *    write only lands while this worker still owns the row, so a worker
 *    whose lease expired (and whose row another worker re-claimed) cannot
 *    overwrite the new owner's outcome — e.g. flip a completed row back to
 *    `failed` and trigger a duplicate send.
 * 4. A background job retries pending/failed effects via the
 *    sideEffectRetryService.
 *
 * Row statuses: pending → running → completed | failed | abandoned |
 * superseded. `superseded` (terminal, never sent) is set by the retry runner
 * for a transition effect whose transition has been overtaken — its
 * appointment's transitionGeneration has moved past the generation stamped
 * on the row at registration (e.g. a "confirmed for Tue 3pm" email still
 * failing after the booking was rescheduled or cancelled).
 */

import { Prisma } from '@prisma/client';
import { prisma } from '../utils/database';
import { logger } from '../utils/logger';
import { createHash } from 'crypto';

// Side effect types
export type SideEffectType =
  | 'justintime_start'
  | 'slack_notify_confirmed'
  | 'slack_notify_cancelled'
  | 'slack_notify_completed'
  | 'email_client_confirmation'
  | 'email_therapist_confirmation'
  | 'email_client_cancellation'
  | 'email_therapist_cancellation'
  | 'email_chase_user'
  | 'email_chase_therapist'
  | 'email_meeting_link_check'
  // Paired effect: sends BOTH the user-feedback-form email and the
  // therapist-feedback-notification email in one execute. Stored as a
  // single tracked row so retry replays the pair atomically; the
  // lifecycle transition to `feedback_requested` lives inside the same
  // execute. Accepts the small duplicate-on-retry risk in exchange for
  // preserving the current "advance status only after both sends"
  // sequence point.
  | 'email_feedback_dispatch'
  | 'email_feedback_reminder'
  // Paired effect: session reminder to user AND therapist. Same single-
  // row shape as email_feedback_dispatch. Partial-success annotation
  // (isStale + notes) lives inside execute; "neither succeeded" throws
  // and lets the harness retry — an improvement over today's
  // sentinel-stuck-at-EPOCH behaviour.
  | 'email_session_reminder_pair'
  // Therapist-scoped: periodic nudge email to a therapist who hasn't
  // been picked for an appointment in a while. Stored on a row scoped
  // by therapistId rather than appointmentId — there's no single
  // appointment context to attach it to.
  | 'email_therapist_nudge'
  | 'user_sync'
  | 'therapist_freeze_sync'
  | 'therapist_unfreeze_sync';

/**
 * Transition that owns the side effect.
 *
 * The five status-driven values (`requested` … `session_held`) match
 * `appointmentRequest.status` transitions one-for-one. The sixth,
 * `periodic`, is for time-driven actions that aren't tied to a status
 * change — chase emails, session reminders, feedback follow-ups, etc.
 * The runPeriodicTrackedSideEffect wrapper writes this transition for
 * its callers so the retry executor's existing per-effect handlers
 * apply uniformly.
 */
export type TransitionType =
  | 'requested'
  | 'confirmed'
  | 'cancelled'
  | 'completed'
  | 'session_held'
  | 'periodic';

export interface SideEffectDefinition {
  effectType: SideEffectType;
  /** Unique key for idempotency (automatically generated if not provided) */
  idempotencyKey?: string;
  /**
   * Optional payload captured at registration time. The retry executor
   * replays this verbatim so retries don't drift from the original outbound
   * (e.g. localised email subject/body, slack args). For effects whose
   * retry executor re-derives state from the DB (slack notifications,
   * Notion syncs), payload can be omitted.
   */
  payload?: unknown;
}

export type SideEffectStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'abandoned'
  | 'superseded';

/** Statuses a row never leaves (the effect will not run again). */
export const TERMINAL_SIDE_EFFECT_STATUSES: readonly SideEffectStatus[] = [
  'completed',
  'abandoned',
  'superseded',
];

export interface RegisteredSideEffect {
  id: string;
  effectType: SideEffectType;
  idempotencyKey: string;
  status: SideEffectStatus;
}

/**
 * Proof that this worker holds a row's execute lease: the `lastAttempt`
 * value tryClaimEffect stamped. Passed back to markCompleted / markFailed /
 * markAbandoned / markSuperseded, whose writes only land while the row is
 * still `running` with exactly this `lastAttempt`.
 */
export type ClaimLease = Date;

/** How long finished (completed/superseded) outbox rows are kept. */
export const SIDE_EFFECT_LOG_RETENTION_DAYS = 30;

/**
 * `transition_generation` is stamped only for status-transition effects —
 * the thing the retry runner compares against the appointment's current
 * generation. For periodic effects the generation argument is a scope
 * generation (a lifecycle pass, a cadence cycle) that only partitions the
 * idempotency key; superseding those is the job of their sentinels.
 */
function stampedGeneration(
  transition: TransitionType,
  transitionGeneration: number | undefined,
): number | null {
  return transition !== 'periodic' && transitionGeneration !== undefined ? transitionGeneration : null;
}

/**
 * How long a worker is allowed to hold the execute lease before another
 * worker can steal the row. Set above the slowest expected execute time
 * (Anthropic+Gmail spikes are typically <60s; 10 min is generous and
 * matches the existing stale-pending pickup window). A worker that holds
 * the lease but dies mid-execute will leave the row in `running` status;
 * `getEffectsToRetry` returns those rows once the lease has expired so
 * another worker can re-claim and re-execute.
 */
const CLAIM_LEASE_MS = 10 * 60 * 1000;

/**
 * Back-off schedule for persisting `completed` AFTER an effect's execute
 * already succeeded (see `markCompletedAfterExecute`). The inline delays
 * are awaited by the caller, so they stay short enough to fit inside
 * runBackgroundTask's 15s default timeout alongside the execute itself.
 * The deferred delays run detached (unref'd timers), each one after the
 * previous deferred attempt failed — 30s, then 90s, then 180s, so the last
 * attempt lands ~5 min after the execute, well inside CLAIM_LEASE_MS. A DB
 * outage of a few minutes is therefore reconciled before the lease-expiry
 * path could re-claim (and re-execute) the row.
 */
const MARK_COMPLETED_INLINE_RETRY_DELAYS_MS = [200, 1000, 3000] as const;
const MARK_COMPLETED_DEFERRED_RETRY_DELAYS_MS = [30_000, 90_000, 180_000] as const;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class SideEffectTrackerService {
  /**
   * Generate an idempotency key for a side effect.
   *
   * The optional `transitionGeneration` differentiates effects fired
   * across re-entries of the same status — the lifecycle service bumps
   * `appointmentRequest.transitionGeneration` on every status change,
   * and threads it through here. Without the generation, a cancel →
   * re-confirm sequence would dedupe the second confirmation's
   * Slack/email side effects against the first confirmation's
   * already-completed rows.
   *
   * Existing rows registered before this column existed used the
   * shorter (id:transition:type) shape; new generation-aware keys hash
   * a different input string so they never collide with old keys.
   */
  private generateIdempotencyKey(
    appointmentId: string,
    transition: TransitionType,
    effectType: SideEffectType,
    transitionGeneration?: number,
  ): string {
    const input =
      transitionGeneration === undefined
        ? `${appointmentId}:${transition}:${effectType}`
        : `${appointmentId}:gen${transitionGeneration}:${transition}:${effectType}`;
    const hash = createHash('sha256')
      .update(input)
      .digest('hex')
      .substring(0, 32);
    return hash;
  }

  /**
   * Idempotency key for therapist-scoped effects.
   *
   * Uses a literal "therapist:" prefix in the hash input to guarantee
   * the key space cannot collide with appointment-scoped keys (which
   * hash `${id}:${transition}:${effectType}` without the prefix), even
   * if a therapist UUID happens to match an appointment UUID.
   *
   * `scopeGeneration` lets callers partition the key space per cadence
   * cycle. Without it, a single 5-retry burst that exhausts and lands
   * in `abandoned` would permanently block future cycles (the next
   * cron tick would re-register with the same hash and short-circuit
   * on the prior abandoned row). Callers that fire on a recurring
   * cadence (therapist-nudge) pass their per-cycle claim timestamp so
   * each cycle gets a fresh row + fresh attempts budget.
   */
  private generateTherapistIdempotencyKey(
    therapistId: string,
    effectType: SideEffectType,
    scopeGeneration?: number,
  ): string {
    const input =
      scopeGeneration === undefined
        ? `therapist:${therapistId}:periodic:${effectType}`
        : `therapist:${therapistId}:gen${scopeGeneration}:periodic:${effectType}`;
    const hash = createHash('sha256')
      .update(input)
      .digest('hex')
      .substring(0, 32);
    return hash;
  }

  /**
   * Register therapist-scoped side effects.
   *
   * Mirrors registerSideEffects for therapists: writes a row with
   * therapistId set + appointmentId left null. The DB CHECK constraint
   * side_effect_logs_scope_check enforces that exactly one of the two
   * is set, so a coding error that fills both would surface as a 500
   * at registration time rather than silently corrupting the schema.
   */
  async registerTherapistSideEffects(
    therapistId: string,
    effects: SideEffectDefinition[],
    scopeGeneration?: number,
  ): Promise<RegisteredSideEffect[]> {
    const registered: RegisteredSideEffect[] = [];

    for (const effect of effects) {
      const idempotencyKey =
        effect.idempotencyKey ||
        this.generateTherapistIdempotencyKey(therapistId, effect.effectType, scopeGeneration);

      try {
        const existing = await prisma.sideEffectLog.findUnique({
          where: { idempotencyKey },
        });

        if (existing) {
          registered.push({
            id: existing.id,
            effectType: effect.effectType,
            idempotencyKey,
            status: existing.status as RegisteredSideEffect['status'],
          });

          if (existing.status === 'completed') {
            logger.debug(
              { therapistId, effectType: effect.effectType },
              'Therapist-scoped side effect already completed - skipping'
            );
          }
          continue;
        }

        const created = await prisma.sideEffectLog.create({
          data: {
            therapistId,
            effectType: effect.effectType,
            transition: 'periodic',
            status: 'pending',
            idempotencyKey,
            payload: effect.payload === undefined
              ? undefined
              : (effect.payload as Prisma.InputJsonValue),
          },
        });

        registered.push({
          id: created.id,
          effectType: effect.effectType,
          idempotencyKey,
          status: 'pending',
        });
      } catch (error) {
        if (
          error instanceof Error &&
          error.message.includes('Unique constraint')
        ) {
          const existing = await prisma.sideEffectLog.findUnique({
            where: { idempotencyKey },
          });
          if (existing) {
            registered.push({
              id: existing.id,
              effectType: effect.effectType,
              idempotencyKey,
              status: existing.status as RegisteredSideEffect['status'],
            });
          }
        } else {
          logger.error(
            { error, therapistId, effectType: effect.effectType },
            'Failed to register therapist-scoped side effect'
          );
          throw error;
        }
      }
    }

    return registered;
  }

  /**
   * Register side effects for a transition
   * Call this BEFORE executing the side effects
   *
   * @param appointmentId - The appointment being transitioned
   * @param transition - The type of transition (confirmed, cancelled, etc.)
   * @param effects - List of side effects to register
   * @returns Registered effects with their IDs
   */
  async registerSideEffects(
    appointmentId: string,
    transition: TransitionType,
    effects: SideEffectDefinition[],
    transitionGeneration?: number,
  ): Promise<RegisteredSideEffect[]> {
    const registered: RegisteredSideEffect[] = [];

    for (const effect of effects) {
      const idempotencyKey =
        effect.idempotencyKey ||
        this.generateIdempotencyKey(appointmentId, transition, effect.effectType, transitionGeneration);

      try {
        // Upsert to handle idempotency - if key exists, return existing record
        const existing = await prisma.sideEffectLog.findUnique({
          where: { idempotencyKey },
        });

        if (existing) {
          // Already registered, return existing status
          registered.push({
            id: existing.id,
            effectType: effect.effectType,
            idempotencyKey,
            status: existing.status as RegisteredSideEffect['status'],
          });

          if (existing.status === 'completed') {
            logger.debug(
              { appointmentId, effectType: effect.effectType },
              'Side effect already completed - skipping'
            );
          }
          continue;
        }

        // Create new side effect record
        const created = await prisma.sideEffectLog.create({
          data: {
            appointmentId,
            effectType: effect.effectType,
            transition,
            status: 'pending',
            idempotencyKey,
            transitionGeneration: stampedGeneration(transition, transitionGeneration),
            payload: effect.payload === undefined
              ? undefined
              : (effect.payload as Prisma.InputJsonValue),
          },
        });

        registered.push({
          id: created.id,
          effectType: effect.effectType,
          idempotencyKey,
          status: 'pending',
        });
      } catch (error) {
        // Handle unique constraint violation (race condition)
        if (
          error instanceof Error &&
          error.message.includes('Unique constraint')
        ) {
          const existing = await prisma.sideEffectLog.findUnique({
            where: { idempotencyKey },
          });
          if (existing) {
            registered.push({
              id: existing.id,
              effectType: effect.effectType,
              idempotencyKey,
              status: existing.status as RegisteredSideEffect['status'],
            });
          }
        } else {
          logger.error(
            { error, appointmentId, effectType: effect.effectType },
            'Failed to register side effect'
          );
          throw error;
        }
      }
    }

    return registered;
  }

  /**
   * Register a single side effect from inside an open transaction. Used by
   * the appointment-creation outbox path: the row is committed atomically
   * with the appointment, so even if the process dies before the in-process
   * task fires, the periodic retry runner has a row to recover.
   *
   * Idempotency: caller-supplied or hash-derived key remains unique across
   * retries. A fresh row is created in 'pending'; the caller flips it to
   * completed/failed once the task resolves. An existing row is reused
   * untouched and its real status returned — see the upsert note below.
   */
  async registerInTransaction(
    tx: Prisma.TransactionClient,
    appointmentId: string,
    transition: TransitionType,
    effect: SideEffectDefinition,
    transitionGeneration?: number,
  ): Promise<RegisteredSideEffect> {
    const idempotencyKey =
      effect.idempotencyKey ||
      this.generateIdempotencyKey(appointmentId, transition, effect.effectType, transitionGeneration);

    // Upsert, not create. A bare create raises a unique-constraint error when
    // the key already exists, and inside a transaction that error ABORTS the
    // whole transaction — Postgres offers no catch-and-continue without a
    // savepoint, so the enclosing status flip rolls back with it. The caller
    // can't recover: it retries, regenerates the same key, and fails again.
    //
    // This is reachable in ordinary operation, not just under a race, because
    // several effects are deliberately keyed WITHOUT a transitionGeneration
    // (therapist_unfreeze_sync on cancelled/completed, therapist_freeze_sync on
    // confirmed) so that the post-commit dispatch finds the same row. Their
    // key is therefore constant for the appointment's lifetime, and any
    // SECOND occurrence of that transition collides. (slack_notify_cancelled
    // used to be listed here too, but notifyCancelled keys it WITH the
    // generation; the in-tx registration now does too — lifecycle audit L6.)
    // Observed in production as a feedback_requested appointment that could
    // never complete: completed once, an admin re-requested feedback, and every
    // subsequent auto-complete sweep died on
    // `Unique constraint failed on the fields: (idempotency_key)`.
    //
    // `update: {}` deliberately leaves an existing row untouched — including a
    // stale payload — because re-registration means "this intent already
    // exists", not "replace it". This matches the tolerance registerSideEffects
    // and registerTherapistSideEffects already had; only this in-transaction
    // path lacked it.
    const row = await tx.sideEffectLog.upsert({
      where: { idempotencyKey },
      create: {
        appointmentId,
        effectType: effect.effectType,
        transition,
        status: 'pending',
        idempotencyKey,
        transitionGeneration: stampedGeneration(transition, transitionGeneration),
        payload:
          effect.payload === undefined
            ? undefined
            : (effect.payload as Prisma.InputJsonValue),
      },
      update: {},
    });

    return {
      id: row.id,
      effectType: effect.effectType,
      idempotencyKey,
      // The row's REAL status, not a hardcoded 'pending'. When an already
      // completed row is reused, telling the caller 'pending' would invite it
      // to dispatch a side effect that has already run.
      status: row.status as RegisteredSideEffect['status'],
    };
  }

  /**
   * Atomically claim a side-effect row for execution. Transitions the row
   * to `status='running'` and stamps `lastAttempt`, but only if the current
   * state is either:
   *   - pending (the row was freshly registered — first execute attempt)
   *   - failed (the row failed previously and is eligible for retry)
   *   - running with an expired lease (a previous worker died mid-execute)
   *
   * Returns the lease token (the stamped `lastAttempt`) if this worker won
   * the claim, or null if another worker holds the lease or the row has
   * moved to a terminal status. Callers pass the lease to the mark* methods.
   *
   * Re-claiming an expired `running` row counts the previous, unfinished
   * attempt (`attempts + 1`). Its worker died without recording an outcome
   * — markFailed never ran — so without this an effect that crashes the
   * process retried every lease period forever and was never abandoned or
   * alerted on. The retry runner abandons such a row once the count reaches
   * its cap.
   *
   * Race-safety: each branch is a single Postgres `updateMany` with the
   * eligible-state filter, which is atomic. If two workers call this
   * concurrently, only one sees `count === 1`. This is the gate that
   * prevents the retry runner from firing a duplicate execute while the
   * original is still in-flight.
   */
  async tryClaimEffect(idempotencyKey: string): Promise<ClaimLease | null> {
    const lease = new Date();
    const fresh = await prisma.sideEffectLog.updateMany({
      where: {
        idempotencyKey,
        status: { in: ['pending', 'failed'] },
      },
      data: {
        status: 'running',
        lastAttempt: lease,
      },
    });
    if (fresh.count === 1) return lease;

    const leaseExpiry = new Date(lease.getTime() - CLAIM_LEASE_MS);
    const orphaned = await prisma.sideEffectLog.updateMany({
      where: {
        idempotencyKey,
        status: 'running',
        lastAttempt: { lt: leaseExpiry },
      },
      data: {
        status: 'running',
        lastAttempt: lease,
        attempts: { increment: 1 },
      },
    });
    return orphaned.count === 1 ? lease : null;
  }

  /**
   * WHERE clause for an outcome write. With a lease: only while this worker
   * still owns the row. Without one (legacy callers that never claimed, e.g.
   * the appointment-creation route's justintime_start row): only while the
   * row is not already in a terminal status, so a late write can never
   * resurrect a completed/abandoned/superseded row.
   */
  private ownedBy(idempotencyKey: string, lease: ClaimLease | undefined): Prisma.SideEffectLogWhereInput {
    return lease
      ? { idempotencyKey, status: 'running', lastAttempt: lease }
      : { idempotencyKey, status: { in: ['pending', 'running', 'failed'] } };
  }

  private logLostLease(idempotencyKey: string, outcome: string, lease: ClaimLease | undefined): void {
    logger.warn(
      { idempotencyKey, outcome, lease: lease?.toISOString() },
      'Side effect outcome not recorded — this worker no longer owns the row (lease expired and re-claimed, or already finished)',
    );
  }

  /**
   * Mark a side effect as completed. Returns false (and writes nothing)
   * when this worker no longer owns the row — see `ownedBy`. Throws only on
   * a database error.
   */
  async markCompleted(idempotencyKey: string, lease?: ClaimLease): Promise<boolean> {
    const result = await prisma.sideEffectLog.updateMany({
      where: this.ownedBy(idempotencyKey, lease),
      data: {
        status: 'completed',
        completedAt: new Date(),
      },
    });
    if (result.count === 0) {
      this.logLostLease(idempotencyKey, 'completed', lease);
      return false;
    }

    logger.debug({ idempotencyKey }, 'Side effect marked completed');
    return true;
  }

  /**
   * Persist `completed` for an effect whose execute has ALREADY resolved.
   *
   * Never throws, and never marks the row failed. Once the email/Slack
   * message/sync has actually happened, a failure to record that fact is
   * a bookkeeping problem, not an effect failure: marking the row
   * `failed` (or re-throwing into runBackgroundTask's in-process retry)
   * would re-claim the row and run the effect a second time — the
   * duplicate-send bug this method exists to prevent (lifecycle audit L3).
   *
   * Strategy:
   *   1. Retry `markCompleted` inline with short back-off (covers pool
   *      timeouts / sub-second DB blips).
   *   2. If still failing, log at error level with the idempotency key
   *      and schedule detached retries that all land inside the execute
   *      lease (CLAIM_LEASE_MS). The row stays `running` meanwhile, so no
   *      other worker can claim it until the lease expires.
   *   3. If the deferred retries also fail, the row is left `running`;
   *      the retry runner's lease-expiry bucket will re-claim it after
   *      CLAIM_LEASE_MS, which DOES re-execute the effect. That residual
   *      duplicate needs a DB outage spanning the whole lease window (or
   *      a process death during it) and is logged loudly so an operator
   *      can reconcile the row by key.
   *
   * A lost lease (markCompleted returns false) is NOT retried: another
   * worker owns the row now and will record its own outcome.
   *
   * Returns true iff `completed` was persisted inline.
   */
  async markCompletedAfterExecute(
    idempotencyKey: string,
    logContext: Record<string, unknown> = {},
    options: {
      lease?: ClaimLease;
      inlineRetryDelaysMs?: readonly number[];
      deferredRetryDelaysMs?: readonly number[];
    } = {},
  ): Promise<boolean> {
    const inlineDelays = options.inlineRetryDelaysMs ?? MARK_COMPLETED_INLINE_RETRY_DELAYS_MS;
    const deferredDelays = options.deferredRetryDelaysMs ?? MARK_COMPLETED_DEFERRED_RETRY_DELAYS_MS;
    const { lease } = options;

    let lastErr: unknown;
    for (let attempt = 0; attempt <= inlineDelays.length; attempt++) {
      if (attempt > 0) {
        await sleep(inlineDelays[attempt - 1]);
      }
      try {
        const recorded = await this.markCompleted(idempotencyKey, lease);
        if (!recorded) return false;
        if (attempt > 0) {
          logger.info(
            { ...logContext, idempotencyKey, attempts: attempt + 1 },
            'Side effect marked completed after retrying markCompleted',
          );
        }
        return true;
      } catch (err) {
        lastErr = err;
      }
    }

    logger.error(
      {
        ...logContext,
        idempotencyKey,
        err: lastErr,
        attempts: inlineDelays.length + 1,
      },
      'Side effect EXECUTED but markCompleted failed — NOT marking failed (would re-send); ' +
        'row left running, deferred reconciliation scheduled inside the execute lease',
    );
    this.scheduleDeferredCompletion(idempotencyKey, logContext, deferredDelays, 0, lease);
    return false;
  }

  private scheduleDeferredCompletion(
    idempotencyKey: string,
    logContext: Record<string, unknown>,
    delaysMs: readonly number[],
    index: number,
    lease: ClaimLease | undefined,
  ): void {
    if (index >= delaysMs.length) {
      logger.error(
        { ...logContext, idempotencyKey },
        'Side effect EXECUTED but could not be marked completed within the execute lease — ' +
          'the retry runner will re-claim it once the lease expires and may re-send it; ' +
          'reconcile this row by idempotency key',
      );
      return;
    }
    const timer = setTimeout(() => {
      this.markCompleted(idempotencyKey, lease).then(
        (recorded) => {
          if (recorded) {
            logger.warn(
              { ...logContext, idempotencyKey, deferredAttempt: index + 1 },
              'Deferred reconciliation: executed side effect marked completed',
            );
          }
        },
        () => {
          this.scheduleDeferredCompletion(idempotencyKey, logContext, delaysMs, index + 1, lease);
        },
      );
    }, delaysMs[index]);
    // Never keep the process alive (or a test worker open) just for this.
    timer.unref?.();
  }

  /**
   * Mark a side effect as failed (can be retried). Increments `attempts`.
   * Returns false (and writes nothing) when this worker no longer owns the
   * row — a stale worker must not flip a row another worker has since
   * completed back to `failed`, which would trigger another execution.
   */
  async markFailed(idempotencyKey: string, errorMessage: string, lease?: ClaimLease): Promise<boolean> {
    const result = await prisma.sideEffectLog.updateMany({
      where: this.ownedBy(idempotencyKey, lease),
      data: {
        status: 'failed',
        attempts: { increment: 1 },
        lastAttempt: new Date(),
        errorLog: errorMessage,
      },
    });
    if (result.count === 0) {
      this.logLostLease(idempotencyKey, 'failed', lease);
      return false;
    }

    logger.warn({ idempotencyKey, errorMessage }, 'Side effect marked failed');
    return true;
  }

  /**
   * Best-effort update of a pending effect's stored payload — used to
   * persist incremental progress within a single execute call (e.g. "the
   * user side of a paired send has landed") so a crash mid-execute leaves
   * a durable record a subsequent retry can read, instead of resending
   * work that already completed. Never throws — a failed update just
   * means the retry falls back to today's behaviour for that one row.
   */
  async updatePayload(idempotencyKey: string, payload: unknown): Promise<void> {
    try {
      await prisma.sideEffectLog.update({
        where: { idempotencyKey },
        data: { payload: payload as Prisma.InputJsonValue },
      });
    } catch (err) {
      logger.warn({ err, idempotencyKey }, 'Failed to persist incremental side-effect payload progress');
    }
  }

  /**
   * Mark a side effect as abandoned (won't be retried). Ownership-checked
   * like markFailed.
   */
  async markAbandoned(idempotencyKey: string, reason: string, lease?: ClaimLease): Promise<boolean> {
    const result = await prisma.sideEffectLog.updateMany({
      where: this.ownedBy(idempotencyKey, lease),
      data: {
        status: 'abandoned',
        errorLog: reason,
      },
    });
    if (result.count === 0) {
      this.logLostLease(idempotencyKey, 'abandoned', lease);
      return false;
    }

    logger.warn({ idempotencyKey, reason }, 'Side effect marked abandoned');
    return true;
  }

  /**
   * Mark a side effect as superseded: terminal, and it was NOT executed.
   * Used by the retry runner for a transition effect whose transition has
   * since been overtaken. `completedAt` is stamped so retention ages the
   * row out like a completed one. Ownership-checked like markFailed.
   */
  async markSuperseded(idempotencyKey: string, reason: string, lease?: ClaimLease): Promise<boolean> {
    const result = await prisma.sideEffectLog.updateMany({
      where: this.ownedBy(idempotencyKey, lease),
      data: {
        status: 'superseded',
        completedAt: new Date(),
        errorLog: reason,
      },
    });
    if (result.count === 0) {
      this.logLostLease(idempotencyKey, 'superseded', lease);
      return false;
    }

    logger.info({ idempotencyKey, reason }, 'Side effect superseded (not sent)');
    return true;
  }

  /**
   * Check if a side effect should be executed
   * Returns true if the effect is pending or failed and should be retried
   */
  async shouldExecute(idempotencyKey: string): Promise<boolean> {
    const effect = await prisma.sideEffectLog.findUnique({
      where: { idempotencyKey },
    });

    if (!effect) {
      // Not registered yet - shouldn't happen in normal flow
      return false;
    }

    // Already finished (completed / abandoned / superseded)
    if ((TERMINAL_SIDE_EFFECT_STATUSES as readonly string[]).includes(effect.status)) {
      return false;
    }

    return true;
  }

  /**
   * Get all pending side effects for an appointment
   */
  async getPendingEffects(appointmentId: string): Promise<RegisteredSideEffect[]> {
    const effects = await prisma.sideEffectLog.findMany({
      where: {
        appointmentId,
        status: { in: ['pending', 'failed'] },
      },
    });

    return effects.map((e) => ({
      id: e.id,
      effectType: e.effectType as SideEffectType,
      idempotencyKey: e.idempotencyKey,
      status: e.status as RegisteredSideEffect['status'],
    }));
  }

  /**
   * Get side effects that should be retried. Used by the background retry
   * runner. Returns two distinct buckets:
   *
   * 1. `failed` rows whose last attempt was long enough ago (the original
   *    retry path).
   * 2. `pending` rows that are older than `stalePendingAfterMs` and have
   *    never been attempted (`attempts: 0`). These are produced by the
   *    transactional outbox path: the row is registered inside an
   *    appointment-creation tx so that even if the process crashes between
   *    commit and the in-process task firing, the runner still picks the
   *    work up. The cutoff is deliberately longer than `retryAfterMs` so
   *    we don't race a still-running in-process attempt.
   *
   * @param maxAttempts - Maximum retry attempts before abandoning
   * @param retryAfterMs - Only retry failed effects whose last attempt was at least this long ago
   * @param limit - Maximum number of effects to return
   * @param stalePendingAfterMs - Pick up pending effects older than this (default: 10 minutes)
   */
  async getEffectsToRetry(
    maxAttempts: number = 5,
    retryAfterMs: number = 60000, // 1 minute
    limit: number = 100,
    stalePendingAfterMs: number = 10 * 60 * 1000, // 10 minutes
  ): Promise<Array<{
    id: string;
    // Scope: exactly one of these is non-null per row (DB CHECK
    // constraint side_effect_logs_scope_check). Callers dispatch on
    // which one is set to decide how to fetch the parent + replay.
    appointmentId: string | null;
    therapistId: string | null;
    effectType: SideEffectType;
    idempotencyKey: string;
    // Status at read time. A `running` row is a crash orphan: claiming it
    // counts the unfinished attempt (see tryClaimEffect), and the runner
    // abandons it at the cap instead of executing it again.
    status: SideEffectStatus;
    attempts: number;
    payload: unknown;
    // The appointment's transitionGeneration when this (transition) effect
    // was registered; null for periodic / therapist-scoped / legacy rows.
    transitionGeneration: number | null;
    // Surface createdAt so post-abandon cleanup hooks can guard
    // against clobbering a newer cycle's claim (see the
    // email_therapist_nudge release path in side-effect-retry).
    createdAt: Date;
  }>> {
    const failedCutoff = new Date(Date.now() - retryAfterMs);
    const stalePendingCutoff = new Date(Date.now() - stalePendingAfterMs);
    // Stuck-running cutoff matches the claim lease — a row in `running`
    // with `lastAttempt` older than this means the original worker died
    // mid-execute (or got network-partitioned) and another worker should
    // re-claim. The CAS in tryClaimEffect uses the same window, so
    // including these rows here is harmless when the original worker is
    // still alive: the CAS will simply lose the race.
    const stuckRunningCutoff = new Date(Date.now() - CLAIM_LEASE_MS);

    const effects = await prisma.sideEffectLog.findMany({
      where: {
        OR: [
          {
            status: 'failed',
            attempts: { lt: maxAttempts },
            lastAttempt: { lt: failedCutoff },
          },
          {
            status: 'pending',
            attempts: 0,
            createdAt: { lt: stalePendingCutoff },
          },
          {
            // Stuck-running recovery: original worker died mid-execute.
            // Deliberately NOT bounded by maxAttempts: an effect that keeps
            // crashing the process must still surface here so the runner
            // can abandon it (and alert) once the re-claims — each of which
            // counts the crashed attempt — reach the cap. Filtering these
            // out left them `running` forever, invisible and unalerted.
            status: 'running',
            lastAttempt: { lt: stuckRunningCutoff },
          },
        ],
      },
      // NULLS FIRST: never-attempted `pending` rows have a null lastAttempt,
      // and Postgres sorts NULLs LAST by default for ASC — so up to `limit`
      // failed/running rows could starve them every cycle.
      orderBy: [{ lastAttempt: { sort: 'asc', nulls: 'first' } }, { createdAt: 'asc' }],
      take: limit,
    });

    return effects.map((e) => ({
      id: e.id,
      appointmentId: e.appointmentId,
      therapistId: e.therapistId,
      effectType: e.effectType as SideEffectType,
      idempotencyKey: e.idempotencyKey,
      status: e.status as SideEffectStatus,
      attempts: e.attempts,
      payload: e.payload as unknown,
      transitionGeneration: e.transitionGeneration,
      createdAt: e.createdAt,
    }));
  }

  /**
   * Delete finished outbox rows (housekeeping). Called by the daily
   * retention sweep (stale-check.service.ts).
   *
   * Only `completed` and `superseded` rows whose `completedAt` is older
   * than the window. Everything else is kept: pending/running/failed rows
   * are live work, and abandoned rows are the record an operator
   * reconciles from. The unique idempotency key on a finished row is the
   * guard against running the effect twice, so the window has to outlast
   * any re-registration of the same key — transition effects re-register
   * within seconds (the post-commit dispatch finding the in-transaction
   * row) and periodic effects are keyed per generation/cycle, so nothing
   * looks up a 30-day-old finished key again.
   *
   * @param olderThanDays - Delete finished effects older than this
   */
  async cleanupOldEffects(olderThanDays: number = SIDE_EFFECT_LOG_RETENTION_DAYS): Promise<number> {
    const cutoffDate = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000);

    const result = await prisma.sideEffectLog.deleteMany({
      where: {
        status: { in: ['completed', 'superseded'] },
        completedAt: { lt: cutoffDate },
      },
    });

    if (result.count > 0) {
      logger.info(
        { deletedCount: result.count, olderThanDays },
        'Cleaned up old side effect logs'
      );
    }

    return result.count;
  }

  /**
   * Get statistics on side effect completion
   */
  async getStats(): Promise<{
    pending: number;
    running: number;
    completed: number;
    failed: number;
    abandoned: number;
    superseded: number;
    byType: Record<string, { pending: number; failed: number }>;
  }> {
    const counts = await prisma.sideEffectLog.groupBy({
      by: ['status'],
      _count: true,
    });

    const byTypeAndStatus = await prisma.sideEffectLog.groupBy({
      by: ['effectType', 'status'],
      where: { status: { in: ['pending', 'failed'] } },
      _count: true,
    });

    const stats = {
      pending: 0,
      running: 0,
      completed: 0,
      failed: 0,
      abandoned: 0,
      superseded: 0,
      byType: {} as Record<string, { pending: number; failed: number }>,
    };

    for (const row of counts) {
      const status = row.status as keyof typeof stats;
      if (status in stats && typeof stats[status] === 'number') {
        (stats as any)[status] = row._count;
      }
    }

    for (const row of byTypeAndStatus) {
      if (!stats.byType[row.effectType]) {
        stats.byType[row.effectType] = { pending: 0, failed: 0 };
      }
      if (row.status === 'pending') {
        stats.byType[row.effectType].pending = row._count;
      } else if (row.status === 'failed') {
        stats.byType[row.effectType].failed = row._count;
      }
    }

    return stats;
  }
}

// Singleton instance
export const sideEffectTrackerService = new SideEffectTrackerService();
