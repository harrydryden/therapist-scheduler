/**
 * Side Effect Retry Service
 *
 * Background service that periodically retries failed side effects
 * (email notifications, Slack messages, etc.) that were registered via
 * the SideEffectTrackerService.
 */

import { logger } from '../utils/logger';
import { LockedPeriodicService } from '../utils/locked-periodic-service';
import { LockedTaskContext } from '../utils/locked-task-runner';
import {
  sideEffectTrackerService,
  SideEffectType,
} from './side-effect-tracker.service';
import { prisma } from '../utils/database';
import { emailQueueService } from './email-queue.service';
import { slackNotificationService } from './slack-notification.service';
import { JustinTimeService } from './justin-time.service';
import { fetchSchedulingContext } from './scheduling-context.service';

const LOCK_KEY = 'side-effect-retry:processing-lock';
const LOCK_TTL_SECONDS = 120;
const LOCK_RENEWAL_INTERVAL_MS = 30 * 1000;
const DEFAULT_CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_RETRY_ATTEMPTS = 5;
const MIN_RETRY_AFTER_MS = 60 * 1000;
const MAX_EFFECTS_PER_RUN = 50;
const STARTUP_DELAY_MS = 30 * 1000;

interface RetryCycleResult {
  retried: number;
  succeeded: number;
  failed: number;
  abandoned: number;
}

class SideEffectRetryService extends LockedPeriodicService<RetryCycleResult> {
  private stats = {
    totalRetried: 0,
    totalSucceeded: 0,
    totalFailed: 0,
    totalAbandoned: 0,
    lastRunTime: null as Date | null,
  };

  constructor() {
    super({
      name: 'side-effect-retry',
      intervalMs: DEFAULT_CHECK_INTERVAL_MS,
      startupDelayMs: STARTUP_DELAY_MS,
      lockKey: LOCK_KEY,
      lockTtlSeconds: LOCK_TTL_SECONDS,
      renewalIntervalMs: LOCK_RENEWAL_INTERVAL_MS,
    });
  }

  protected async tick(ctx: LockedTaskContext): Promise<RetryCycleResult> {
    const result = await this.retryFailedEffects(ctx.isLockValid);

    this.stats.lastRunTime = new Date();
    this.stats.totalRetried += result.retried;
    this.stats.totalSucceeded += result.succeeded;
    this.stats.totalFailed += result.failed;
    this.stats.totalAbandoned += result.abandoned;

    if (result.retried > 0) {
      logger.info(result, 'Side effect retry cycle complete');
    } else {
      logger.debug('No side effects to retry');
    }

    return result;
  }

  private async retryFailedEffects(
    isLockValid: () => boolean
  ): Promise<RetryCycleResult> {
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
      if (!isLockValid()) {
        logger.warn('Aborting side effect retry - lock lost');
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

          try {
            await slackNotificationService.sendAlert({
              title: 'Side Effect Abandoned',
              severity: 'high',
              appointmentId: effect.appointmentId,
              details: `\`${effect.effectType}\` failed after *${nextAttempt}* attempts and was abandoned. Manual intervention may be needed.\n*Last error:* ${errorMessage.slice(0, 200)}`,
            });
          } catch {
            // Don't let Slack failure mask the original error
          }
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

  private async executeEffect(effect: {
    id: string;
    appointmentId: string;
    effectType: SideEffectType;
    idempotencyKey: string;
    attempts: number;
    payload: unknown;
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
      case 'justintime_start': {
        // Outbox recovery for the appointment-creation flow. The row is
        // registered inside the appointment-creation tx; this executor runs
        // when either the in-process startScheduling never resolved (process
        // crashed between commit and run) or it threw and was marked failed.
        //
        // Idempotency: skip if the appointment has already been advanced
        // beyond `pending`, or if any conversation activity has been
        // recorded (messageCount > 0 / conversationState saved). The narrow
        // "emails sent but state save failed" window is intentionally not
        // re-driven here — that case logs COMPENSATION REQUIRED and waits
        // for manual intervention rather than risking duplicate outreach.
        const richAppointment = await prisma.appointmentRequest.findUnique({
          where: { id: effect.appointmentId },
          select: {
            id: true,
            status: true,
            messageCount: true,
            conversationState: true,
          },
        });

        if (!richAppointment) {
          throw new Error(
            `Appointment ${effect.appointmentId} not found - cannot retry justintime_start`,
          );
        }

        if (richAppointment.status !== 'pending') {
          logger.info(
            { effectId: effect.id, appointmentId: effect.appointmentId, status: richAppointment.status },
            'justintime_start retry skipped: appointment already advanced',
          );
          return;
        }

        if (richAppointment.messageCount > 0 || richAppointment.conversationState !== null) {
          logger.warn(
            { effectId: effect.id, appointmentId: effect.appointmentId },
            'justintime_start retry skipped: conversation activity already recorded; manual intervention may be required',
          );
          return;
        }

        const context = await fetchSchedulingContext(effect.appointmentId, `retry:${effect.idempotencyKey}`);
        if (!context) {
          throw new Error(
            `Failed to build scheduling context for ${effect.appointmentId}`,
          );
        }

        const justinTime = new JustinTimeService(`retry:${effect.idempotencyKey}`);
        await justinTime.startScheduling(context);
        break;
      }

      case 'email_client_confirmation':
      case 'email_therapist_confirmation':
      case 'email_client_cancellation':
      case 'email_therapist_cancellation': {
        // Replay the email using the rendered payload captured at registration
        // time. We never re-render the template on retry — settings could
        // have changed between the original send and the retry, and a stale
        // English-fallback was the original reason this retry path was unused
        // for emails. If the payload is missing (effect was registered before
        // payload support), abandon rather than send something wrong.
        const payload = effect.payload as
          | { to: string; subject: string; body: string; threadId?: string | null }
          | null
          | undefined;
        if (!payload || typeof payload.to !== 'string' || typeof payload.subject !== 'string' || typeof payload.body !== 'string') {
          throw new Error(
            `Cannot retry ${effect.effectType}: missing or invalid stored payload — registration predates payload support`,
          );
        }
        await emailQueueService.enqueue({
          to: payload.to,
          subject: payload.subject,
          body: payload.body,
          appointmentId: appointment.id,
          ...(payload.threadId ? { threadId: payload.threadId } : {}),
        });
        break;
      }

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
        await slackNotificationService.notifyAppointmentCompleted(
          appointment.id,
          appointment.userName,
          appointment.therapistName
        );
        break;

      // Legacy effect types from when Notion was authoritative. They no
      // longer have any work to do — Postgres is the source of truth, and
      // the data they used to mirror is written inline by the transition
      // path. Treat as no-ops so that pre-existing rows in side_effect_logs
      // drain cleanly without throwing.
      case 'user_sync':
      case 'therapist_freeze_sync':
      case 'therapist_unfreeze_sync':
        logger.debug(
          { effectType: effect.effectType, appointmentId: appointment.id },
          'Skipping legacy Notion-mirror side effect (no-op post-cutover)',
        );
        break;

      default:
        throw new Error(`Unknown side effect type: ${effect.effectType}`);
    }
  }

  getStatus() {
    return {
      ...super.getStatus(),
      instanceId: this.instanceId,
      stats: { ...this.stats },
    };
  }
}

export const sideEffectRetryService = new SideEffectRetryService();
