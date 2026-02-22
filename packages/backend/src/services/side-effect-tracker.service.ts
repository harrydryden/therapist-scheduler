/**
 * Side Effect Tracker Service
 *
 * Implements a two-phase commit pattern for appointment status transitions.
 * Ensures all side effects (notifications, syncs, etc.) are tracked and can be:
 * - Retried if they fail
 * - Monitored for completion
 * - Idempotent (no duplicate execution)
 *
 * This solves the problem where an appointment might be marked "confirmed" in the
 * database, but the user never receives the confirmation email due to a transient failure.
 *
 * Usage:
 * 1. Before executing side effects, register them with registerSideEffects()
 * 2. Execute each side effect and call markCompleted() or markFailed()
 * 3. A background job can retry failed effects via retryPendingEffects()
 */

import { prisma } from '../utils/database';
import { logger } from '../utils/logger';
import { createHash } from 'crypto';

// Side effect types
export type SideEffectType =
  | 'slack_notify_confirmed'
  | 'slack_notify_cancelled'
  | 'slack_notify_completed'
  | 'email_client_confirmation'
  | 'email_therapist_confirmation'
  | 'user_sync'
  | 'therapist_freeze_sync'
  | 'therapist_unfreeze_sync';

export type TransitionType = 'confirmed' | 'cancelled' | 'completed' | 'session_held';

export interface SideEffectDefinition {
  effectType: SideEffectType;
  /** Unique key for idempotency (automatically generated if not provided) */
  idempotencyKey?: string;
}

export interface RegisteredSideEffect {
  id: string;
  effectType: SideEffectType;
  idempotencyKey: string;
  status: 'pending' | 'completed' | 'failed' | 'abandoned';
}

class SideEffectTrackerService {
  /**
   * Generate an idempotency key for a side effect
   * This ensures the same effect isn't executed twice
   */
  private generateIdempotencyKey(
    appointmentId: string,
    transition: TransitionType,
    effectType: SideEffectType
  ): string {
    const hash = createHash('sha256')
      .update(`${appointmentId}:${transition}:${effectType}`)
      .digest('hex')
      .substring(0, 32);
    return hash;
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
    effects: SideEffectDefinition[]
  ): Promise<RegisteredSideEffect[]> {
    const registered: RegisteredSideEffect[] = [];

    for (const effect of effects) {
      const idempotencyKey =
        effect.idempotencyKey ||
        this.generateIdempotencyKey(appointmentId, transition, effect.effectType);

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
   * Get failed side effects that should be retried
   * Used by background retry job
   *
   * @param maxAttempts - Maximum retry attempts before abandoning
   * @param retryAfterMs - Only retry effects that failed at least this long ago
   * @param limit - Maximum number of effects to return
   */
  async getEffectsToRetry(
    maxAttempts: number = 5,
    retryAfterMs: number = 60000, // 1 minute
    limit: number = 100
  ): Promise<Array<{
    id: string;
    appointmentId: string;
    effectType: SideEffectType;
    idempotencyKey: string;
    attempts: number;
  }>> {
    const cutoffTime = new Date(Date.now() - retryAfterMs);

    const effects = await prisma.sideEffectLog.findMany({
      where: {
        status: 'failed',
        attempts: { lt: maxAttempts },
        lastAttempt: { lt: cutoffTime },
      },
      orderBy: { lastAttempt: 'asc' },
      take: limit,
    });

    return effects.map((e) => ({
      id: e.id,
      appointmentId: e.appointmentId,
      effectType: e.effectType as SideEffectType,
      idempotencyKey: e.idempotencyKey,
      attempts: e.attempts,
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
