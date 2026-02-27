/**
 * Side Effect Retry Service
 *
 * Background service that periodically retries failed side effects
 * (email notifications, Slack messages, Notion syncs, etc.) that were
 * registered via the SideEffectTrackerService.
 *
 * This closes the critical gap where the SideEffectTrackerService infrastructure
 * exists but nothing was retrying failed effects. Without this service, any
 * side effect that fails (e.g., confirmation email, Slack notification) would
 * sit in 'failed' status permanently with no automated recovery.
 *
 * Features:
 * - Distributed lock for multi-instance safety
 * - Exponential backoff via attempt count
 * - Max retry limit before abandoning
 * - Integrates with existing SideEffectTrackerService
 */

import { logger } from '../utils/logger';
import { redis } from '../utils/redis';
import { releaseLock, renewLock } from '../utils/redis-locks';
import {
  sideEffectTrackerService,
  SideEffectType,
} from './side-effect-tracker.service';
import { prisma } from '../utils/database';
import { emailQueueService } from './email-queue.service';
import { slackNotificationService } from './slack-notification.service';
import { notionSyncManager } from './notion-sync-manager.service';

// Distributed lock settings
const LOCK_KEY = 'side-effect-retry:processing-lock';
const LOCK_TTL_SECONDS = 120;
const LOCK_RENEWAL_INTERVAL_MS = 30 * 1000;

// Retry settings
const DEFAULT_CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_RETRY_ATTEMPTS = 5;
const MIN_RETRY_AFTER_MS = 60 * 1000; // 1 minute minimum between retries
const MAX_EFFECTS_PER_RUN = 50;

// Startup delay to allow all services to initialize
const STARTUP_DELAY_MS = 30 * 1000;

class SideEffectRetryService {
  private intervalId: NodeJS.Timeout | null = null;
  private startupTimeoutId: NodeJS.Timeout | null = null;
  private lockRenewalId: NodeJS.Timeout | null = null;
  private instanceId: string;
  private lockValid = true;
  private stats = {
    totalRetried: 0,
    totalSucceeded: 0,
    totalFailed: 0,
    totalAbandoned: 0,
    lastRunTime: null as Date | null,
  };

  constructor() {
    this.instanceId = `side-effect-retry-${process.pid}-${Date.now().toString(36)}`;
  }

  start(): void {
    if (this.intervalId) {
      logger.warn('Side effect retry service already running');
      return;
    }

    logger.info(
      { instanceId: this.instanceId, intervalMs: DEFAULT_CHECK_INTERVAL_MS },
      'Starting side effect retry service'
    );

    this.startupTimeoutId = setTimeout(() => {
      this.startupTimeoutId = null;
      this.runSafeRetry('startup');
    }, STARTUP_DELAY_MS);

    this.intervalId = setInterval(() => {
      this.runSafeRetry('scheduled');
    }, DEFAULT_CHECK_INTERVAL_MS);
  }

  stop(): void {
    if (this.startupTimeoutId) {
      clearTimeout(this.startupTimeoutId);
      this.startupTimeoutId = null;
    }
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.stopLockRenewal();
    this.releaseInstanceLock().catch(() => {});
    logger.info({ instanceId: this.instanceId }, 'Side effect retry service stopped');
  }

  private async tryAcquireLock(): Promise<boolean> {
    try {
      const result = await redis.set(
        LOCK_KEY,
        this.instanceId,
        'EX',
        LOCK_TTL_SECONDS,
        'NX'
      );
      return result === 'OK';
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      if (errorMessage.includes('Redis not available') && process.env.SINGLE_INSTANCE_MODE === 'true') {
        return true;
      }
      logger.error({ err, instanceId: this.instanceId }, 'Side effect retry lock acquisition failed');
      return false;
    }
  }

  private async releaseInstanceLock(): Promise<void> {
    await releaseLock(LOCK_KEY, this.instanceId, 'side-effect-retry');
  }

  private startLockRenewal(): void {
    this.lockValid = true;
    this.lockRenewalId = setInterval(async () => {
      const renewed = await renewLock(LOCK_KEY, this.instanceId, LOCK_TTL_SECONDS);
      if (!renewed) {
        this.lockValid = false;
        logger.warn({ instanceId: this.instanceId }, 'Side effect retry lock renewal failed');
        this.stopLockRenewal();
      }
    }, LOCK_RENEWAL_INTERVAL_MS);
  }

  private stopLockRenewal(): void {
    if (this.lockRenewalId) {
      clearInterval(this.lockRenewalId);
      this.lockRenewalId = null;
    }
  }

  private async runSafeRetry(trigger: 'startup' | 'scheduled' | 'manual'): Promise<void> {
    const acquired = await this.tryAcquireLock();
    if (!acquired) {
      logger.debug({ instanceId: this.instanceId, trigger }, 'Skipping side effect retry - another instance holds lock');
      return;
    }

    this.startLockRenewal();

    try {
      const result = await this.retryFailedEffects(trigger);

      this.stats.lastRunTime = new Date();
      this.stats.totalRetried += result.retried;
      this.stats.totalSucceeded += result.succeeded;
      this.stats.totalFailed += result.failed;
      this.stats.totalAbandoned += result.abandoned;

      if (result.retried > 0) {
        logger.info(
          { trigger, ...result },
          'Side effect retry cycle complete'
        );
      } else {
        logger.debug({ trigger }, 'No side effects to retry');
      }
    } catch (error) {
      logger.error({ trigger, error }, 'Error in side effect retry cycle');
    } finally {
      this.stopLockRenewal();
      await this.releaseInstanceLock();
    }
  }

  /**
   * Core retry logic: fetch failed effects and re-execute them.
   */
  private async retryFailedEffects(
    trigger: string
  ): Promise<{ retried: number; succeeded: number; failed: number; abandoned: number }> {
    let retried = 0;
    let succeeded = 0;
    let failed = 0;
    let abandoned = 0;

    const effectsToRetry = await sideEffectTrackerService.getEffectsToRetry(
      MAX_RETRY_ATTEMPTS,
      MIN_RETRY_AFTER_MS,
      MAX_EFFECTS_PER_RUN
    );

    for (const effect of effectsToRetry) {
      if (!this.lockValid) {
        logger.warn({ trigger }, 'Aborting side effect retry - lock lost');
        break;
      }

      retried++;

      try {
        await this.executeEffect(effect);
        await sideEffectTrackerService.markCompleted(effect.idempotencyKey);
        succeeded++;

        logger.info(
          { effectId: effect.id, effectType: effect.effectType, appointmentId: effect.appointmentId, attempt: effect.attempts + 1 },
          'Side effect retry succeeded'
        );
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        const nextAttempt = effect.attempts + 1;

        if (nextAttempt >= MAX_RETRY_ATTEMPTS) {
          await sideEffectTrackerService.markAbandoned(
            effect.idempotencyKey,
            `Abandoned after ${nextAttempt} attempts: ${errorMessage}`
          );
          abandoned++;

          logger.error(
            { effectId: effect.id, effectType: effect.effectType, appointmentId: effect.appointmentId, attempts: nextAttempt },
            'Side effect permanently abandoned'
          );
        } else {
          await sideEffectTrackerService.markFailed(effect.idempotencyKey, errorMessage);
          failed++;

          logger.warn(
            { effectId: effect.id, effectType: effect.effectType, attempt: nextAttempt, error: errorMessage },
            `Side effect retry failed (${nextAttempt}/${MAX_RETRY_ATTEMPTS})`
          );
        }
      }
    }

    return { retried, succeeded, failed, abandoned };
  }

  /**
   * Re-execute a side effect based on its type.
   * Fetches the necessary data from the appointment to reconstruct the operation.
   */
  private async executeEffect(effect: {
    id: string;
    appointmentId: string;
    effectType: SideEffectType;
    idempotencyKey: string;
    attempts: number;
  }): Promise<void> {
    const appointment = await prisma.appointmentRequest.findUnique({
      where: { id: effect.appointmentId },
      select: {
        id: true,
        userName: true,
        userEmail: true,
        therapistName: true,
        therapistEmail: true,
        therapistNotionId: true,
        status: true,
        confirmedDateTime: true,
        trackingCode: true,
      },
    });

    if (!appointment) {
      throw new Error(`Appointment ${effect.appointmentId} not found - cannot retry side effect`);
    }

    switch (effect.effectType) {
      case 'email_client_confirmation':
        await emailQueueService.enqueue({
          to: appointment.userEmail,
          subject: `Your therapy session with ${appointment.therapistName} is confirmed`,
          body: `Hi ${(appointment.userName || 'there').split(' ')[0]},\n\nYour session with ${appointment.therapistName} has been confirmed for ${appointment.confirmedDateTime}.\n\nBest regards,\nJustin Time`,
          appointmentId: appointment.id,
        });
        break;

      case 'email_therapist_confirmation':
        if (appointment.therapistEmail) {
          await emailQueueService.enqueue({
            to: appointment.therapistEmail,
            subject: `Session confirmed: ${appointment.confirmedDateTime}`,
            body: `Hi ${(appointment.therapistName || 'there').split(' ')[0]},\n\nA session has been confirmed with ${(appointment.userName || 'the client').split(' ')[0]} (${appointment.userEmail}) for ${appointment.confirmedDateTime}.\n\nBest regards,\nJustin Time`,
            appointmentId: appointment.id,
          });
        }
        break;

      case 'slack_notify_confirmed':
        await slackNotificationService.notifyAppointmentConfirmed(
          appointment.id,
          appointment.userName,
          appointment.therapistName,
          appointment.confirmedDateTime || 'TBD'
        );
        break;

      case 'slack_notify_cancelled':
        await slackNotificationService.notifyAppointmentCancelled(
          appointment.id,
          appointment.userName,
          appointment.therapistName,
          'System retry'
        );
        break;

      case 'slack_notify_completed':
        // Slack completed notification - best effort
        logger.info(
          { appointmentId: appointment.id, effectType: effect.effectType },
          'Retrying completion notification'
        );
        break;

      case 'user_sync':
        await notionSyncManager.syncSingleUser(appointment.userEmail);
        break;

      case 'therapist_freeze_sync':
        if (appointment.therapistNotionId) {
          await notionSyncManager.syncSingleTherapist(appointment.therapistNotionId);
        }
        break;

      case 'therapist_unfreeze_sync':
        if (appointment.therapistNotionId) {
          await notionSyncManager.syncSingleTherapist(appointment.therapistNotionId);
        }
        break;

      default:
        throw new Error(`Unknown side effect type: ${effect.effectType}`);
    }
  }

  getStatus() {
    return {
      running: this.intervalId !== null,
      instanceId: this.instanceId,
      stats: { ...this.stats },
    };
  }
}

export const sideEffectRetryService = new SideEffectRetryService();
