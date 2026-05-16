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
 * 2. Execute each side effect and call markCompleted() or markFailed()
 * 3. A background job retries pending/failed effects via the
 *    sideEffectRetryService.
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

export interface RegisteredSideEffect {
  id: string;
  effectType: SideEffectType;
  idempotencyKey: string;
  status: 'pending' | 'completed' | 'failed' | 'abandoned';
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
   * retries. The row is created in 'pending'; the caller flips it to
   * completed/failed once the task resolves.
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

    const created = await tx.sideEffectLog.create({
      data: {
        appointmentId,
        effectType: effect.effectType,
        transition,
        status: 'pending',
        idempotencyKey,
        payload:
          effect.payload === undefined
            ? undefined
            : (effect.payload as Prisma.InputJsonValue),
      },
    });

    return {
      id: created.id,
      effectType: effect.effectType,
      idempotencyKey,
      status: 'pending',
    };
  }

  /**
   * Mark a side effect as completed
   */
  async markCompleted(idempotencyKey: string): Promise<void> {
    await prisma.sideEffectLog.update({
      where: { idempotencyKey },
      data: {
        status: 'completed',
        completedAt: new Date(),
      },
    });

    logger.debug({ idempotencyKey }, 'Side effect marked completed');
  }

  /**
   * Mark a side effect as failed (can be retried)
   */
  async markFailed(idempotencyKey: string, errorMessage: string): Promise<void> {
    await prisma.sideEffectLog.update({
      where: { idempotencyKey },
      data: {
        status: 'failed',
        attempts: { increment: 1 },
        lastAttempt: new Date(),
        errorLog: errorMessage,
      },
    });

    logger.warn({ idempotencyKey, errorMessage }, 'Side effect marked failed');
  }

  /**
   * Mark a side effect as abandoned (won't be retried)
   */
  async markAbandoned(idempotencyKey: string, reason: string): Promise<void> {
    await prisma.sideEffectLog.update({
      where: { idempotencyKey },
      data: {
        status: 'abandoned',
        errorLog: reason,
      },
    });

    logger.warn({ idempotencyKey, reason }, 'Side effect marked abandoned');
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

    // Already completed or abandoned
    if (effect.status === 'completed' || effect.status === 'abandoned') {
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
    attempts: number;
    payload: unknown;
    // Surface createdAt so post-abandon cleanup hooks can guard
    // against clobbering a newer cycle's claim (see the
    // email_therapist_nudge release path in side-effect-retry).
    createdAt: Date;
  }>> {
    const failedCutoff = new Date(Date.now() - retryAfterMs);
    const stalePendingCutoff = new Date(Date.now() - stalePendingAfterMs);

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
        ],
      },
      orderBy: [{ lastAttempt: 'asc' }, { createdAt: 'asc' }],
      take: limit,
    });

    return effects.map((e) => ({
      id: e.id,
      appointmentId: e.appointmentId,
      therapistId: e.therapistId,
      effectType: e.effectType as SideEffectType,
      idempotencyKey: e.idempotencyKey,
      attempts: e.attempts,
      payload: e.payload as unknown,
      createdAt: e.createdAt,
    }));
  }

  /**
   * Clean up old completed effects (housekeeping)
   *
   * @param olderThanDays - Delete completed effects older than this
   */
  async cleanupOldEffects(olderThanDays: number = 30): Promise<number> {
    const cutoffDate = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000);

    const result = await prisma.sideEffectLog.deleteMany({
      where: {
        status: 'completed',
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
    completed: number;
    failed: number;
    abandoned: number;
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
      completed: 0,
      failed: 0,
      abandoned: 0,
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
