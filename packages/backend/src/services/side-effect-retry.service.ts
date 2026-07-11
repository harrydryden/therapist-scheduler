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
import { therapistBookingStatusService } from './therapist-booking-status.service';
import { APPOINTMENT_STATUS } from '../constants';

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

      // Atomic claim before execute. Without this, two retry runners
      // (or a retry runner racing the original in-process worker on a
      // stale-pending row) would both run executeEffect — producing
      // duplicate user-visible side effects. The CAS in tryClaimEffect
      // ensures only one worker proceeds. If we lose the race, skip
      // silently: the winning worker will mark the row's terminal state.
      const claimed = await sideEffectTrackerService.tryClaimEffect(
        effect.idempotencyKey,
      );
      if (!claimed) {
        logger.debug(
          { effectId: effect.id, effectType: effect.effectType, appointmentId: effect.appointmentId },
          'Side effect retry skipped — execute-lease held by another worker',
        );
        continue;
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

          await this.postAbandonCleanup(effect);

          try {
            await slackNotificationService.sendAlert({
              title: 'Side Effect Abandoned',
              severity: 'high',
              // Therapist-scoped effects have no appointmentId — surface the
              // therapist ID in the details body so the alert is still
              // actionable.
              appointmentId: effect.appointmentId ?? undefined,
              details: `\`${effect.effectType}\` failed after *${nextAttempt}* attempts and was abandoned.${effect.therapistId ? ` (therapistId: ${effect.therapistId})` : ''} Manual intervention may be needed.\n*Last error:* ${errorMessage.slice(0, 200)}`,
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

  /**
   * Effect-type-specific cleanup after an abandon.
   *
   * For effects whose parent row carries a sentinel that gates future
   * cron ticks (currently only Therapist.lastNudgeAt for
   * email_therapist_nudge), the sentinel must be released here or the
   * next scheduled tick will see "claim still owned by previous cycle"
   * and skip the therapist for intervalWeeks — turning a transient
   * outage that outlasted the 5-attempt budget into a multi-week
   * silence.
   *
   * Guard: only release if the current sentinel value is older than
   * this row's createdAt. If a newer cycle has already claimed
   * (Therapist.lastNudgeAt > row.createdAt), some other cycle is in
   * flight and we must not clobber its claim.
   */
  private async postAbandonCleanup(effect: {
    id: string;
    effectType: SideEffectType;
    therapistId: string | null;
    createdAt: Date;
  }): Promise<void> {
    if (effect.effectType !== 'email_therapist_nudge' || !effect.therapistId) {
      return;
    }
    try {
      const result = await prisma.therapist.updateMany({
        where: {
          id: effect.therapistId,
          lastNudgeAt: { lt: effect.createdAt },
        },
        data: { lastNudgeAt: null },
      });
      if (result.count > 0) {
        logger.info(
          { effectId: effect.id, therapistId: effect.therapistId },
          'Released therapist nudge sentinel after abandon — next cron tick will re-evaluate',
        );
      }
    } catch (err) {
      logger.error(
        { err, effectId: effect.id, therapistId: effect.therapistId },
        'Failed to release nudge sentinel after abandon — therapist may not be re-considered until intervalWeeks elapses',
      );
    }
  }

  private async executeEffect(effect: {
    id: string;
    appointmentId: string | null;
    therapistId: string | null;
    effectType: SideEffectType;
    idempotencyKey: string;
    attempts: number;
    payload: unknown;
  }): Promise<void> {
    // Dispatch on scope (DB CHECK enforces exactly one set). Therapist-
    // scoped retries don't need an appointment row — they re-fetch the
    // therapist and replay the rendered payload.
    if (effect.therapistId && !effect.appointmentId) {
      await this.executeTherapistEffect({
        id: effect.id,
        therapistId: effect.therapistId,
        effectType: effect.effectType,
        idempotencyKey: effect.idempotencyKey,
        attempts: effect.attempts,
        payload: effect.payload,
      });
      return;
    }

    if (!effect.appointmentId) {
      throw new Error(`Side effect ${effect.id} has neither appointmentId nor therapistId`);
    }

    const appointment = await prisma.appointmentRequest.findUnique({
      where: { id: effect.appointmentId },
      select: {
        id: true,
        userName: true,
        userEmail: true,
        therapistName: true,
        therapistEmail: true,
        therapistHandle: true,
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
      case 'email_therapist_cancellation':
      // Periodic (non-transition) emails registered via
      // runPeriodicTrackedSideEffect. Same payload shape, same replay
      // path — the renderer captures a fully-rendered {to, subject,
      // body, threadId?} envelope at original-send time, and we
      // enqueue it verbatim on retry. We deliberately do NOT re-render
      // on retry: settings drift (e.g. tracking URL, salutation
      // template) between original send and retry would produce a
      // surprising second email.
      case 'email_chase_user':
      case 'email_chase_therapist':
      case 'email_meeting_link_check':
      case 'email_feedback_reminder': {
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

      case 'email_feedback_dispatch':
      case 'email_session_reminder_pair': {
        // Paired periodic effect: two emails registered as one tracked
        // row. Payload carries both envelopes so retry replays both,
        // matching the original execute's atomicity (the pair is the
        // unit of work). Same "never re-render" contract as the single
        // case above.
        //
        // Duplicate-on-retry risk: if the first attempt sent one of
        // the two and then crashed, retry sends BOTH again — the
        // already-delivered recipient gets a duplicate. We accept this
        // bounded-by-MAX_RETRY_ATTEMPTS cost in exchange for
        // sequencing the lifecycle transition (feedback_dispatch only)
        // and partial-success annotation (session_reminder_pair only)
        // correctly relative to the sends.
        const payload = effect.payload as
          | {
              user: { to: string; subject: string; body: string; threadId?: string | null };
              therapist: { to: string; subject: string; body: string; threadId?: string | null };
            }
          | null
          | undefined;
        if (
          !payload ||
          !payload.user ||
          !payload.therapist ||
          typeof payload.user.to !== 'string' ||
          typeof payload.therapist.to !== 'string'
        ) {
          throw new Error(
            `Cannot retry ${effect.effectType}: missing or invalid paired payload — expected { user, therapist } envelopes`,
          );
        }
        await emailQueueService.enqueue({
          to: payload.user.to,
          subject: payload.user.subject,
          body: payload.user.body,
          appointmentId: appointment.id,
          ...(payload.user.threadId ? { threadId: payload.user.threadId } : {}),
        });
        await emailQueueService.enqueue({
          to: payload.therapist.to,
          subject: payload.therapist.subject,
          body: payload.therapist.body,
          appointmentId: appointment.id,
          ...(payload.therapist.threadId ? { threadId: payload.therapist.threadId } : {}),
        });
        break;
      }

      case 'slack_notify_confirmed':
        await slackNotificationService.notifyAppointmentConfirmed({
          appointmentId: appointment.id,
          therapistName: appointment.therapistName,
          confirmedDateTime: appointment.confirmedDateTime || 'TBD',
        });
        break;

      case 'slack_notify_cancelled':
        await slackNotificationService.notifyAppointmentCancelled({
          appointmentId: appointment.id,
          therapistName: appointment.therapistName,
          reason: 'System retry',
        });
        break;

      case 'slack_notify_completed':
        await slackNotificationService.notifyAppointmentCompleted({
          appointmentId: appointment.id,
          therapistName: appointment.therapistName,
        });
        break;

      case 'therapist_freeze_sync': {
        // Re-driven freeze for an appointment whose original onConfirmed
        // hit a transient Postgres failure. We re-derive the operation
        // from the current appointment row: only freeze if the row is
        // still in `confirmed`. If it drifted (cancelled/completed in
        // the meantime), the freeze is wrong and the unfreeze path will
        // already have run; skip.
        if (!appointment.therapistHandle) {
          logger.info(
            { effectType: effect.effectType, appointmentId: appointment.id },
            'therapist_freeze_sync no-op: appointment has no therapistHandle',
          );
          break;
        }
        if (appointment.status !== APPOINTMENT_STATUS.CONFIRMED) {
          logger.info(
            { effectType: effect.effectType, appointmentId: appointment.id, status: appointment.status },
            'therapist_freeze_sync no-op: appointment no longer confirmed',
          );
          break;
        }
        await therapistBookingStatusService.markConfirmed(
          appointment.therapistHandle,
          appointment.therapistName ?? 'unknown therapist',
        );
        break;
      }

      case 'therapist_unfreeze_sync': {
        // Re-driven unfreeze for completed/cancelled appointments. The
        // operations are all idempotent so it's safe to re-run, even if
        // the in-process attempt partially completed before failing.
        if (!appointment.therapistHandle) {
          logger.info(
            { effectType: effect.effectType, appointmentId: appointment.id },
            'therapist_unfreeze_sync no-op: appointment has no therapistHandle',
          );
          break;
        }
        const handle = appointment.therapistHandle;
        await therapistBookingStatusService.unmarkConfirmed(handle);
        await therapistBookingStatusService.recalculateUniqueRequestCount(handle);
        // Note: the therapist's `active` flag is deliberately not touched
        // here. Booking-page visibility is an admin-only toggle, decoupled
        // from the appointment lifecycle — a terminated appointment must
        // not deactivate the therapist. (Mirrors onCancelled/onCompleted in
        // transition-side-effects.service.ts.)
        break;
      }

      // Legacy: when Notion was authoritative, user_sync mirrored the
      // user record there. With Notion retired, there's no work to do.
      // Pre-existing rows still drain through here without throwing.
      case 'user_sync':
        logger.debug(
          { effectType: effect.effectType, appointmentId: appointment.id },
          'Skipping legacy user_sync side effect (no-op post-Notion-cutover)',
        );
        break;

      default:
        throw new Error(`Unknown side effect type: ${effect.effectType}`);
    }
  }

  /**
   * Replay a therapist-scoped tracked side effect.
   *
   * Therapist scope is used by cadence comms that aren't tied to any
   * one appointment (e.g. the periodic therapist-nudge email). The
   * payload shape mirrors appointment-scoped periodic emails — a fully
   * rendered { to, subject, body } envelope captured at registration
   * time — but the therapist row is the parent, so we don't enqueue
   * with an appointmentId.
   */
  private async executeTherapistEffect(effect: {
    id: string;
    therapistId: string;
    effectType: SideEffectType;
    idempotencyKey: string;
    attempts: number;
    payload: unknown;
  }): Promise<void> {
    const therapist = await prisma.therapist.findUnique({
      where: { id: effect.therapistId },
      select: { id: true, email: true, name: true, active: true },
    });

    if (!therapist) {
      throw new Error(`Therapist ${effect.therapistId} not found - cannot retry side effect`);
    }

    // A therapist deactivated between original send and retry: skip
    // the replay rather than send. The retry runner will mark this
    // effect completed, suppressing further attempts.
    if (!therapist.active) {
      logger.info(
        { effectId: effect.id, therapistId: effect.therapistId, effectType: effect.effectType },
        'Therapist is inactive - skipping replay'
      );
      return;
    }

    switch (effect.effectType) {
      case 'email_therapist_nudge': {
        const payload = effect.payload as
          | { to: string; subject: string; body: string }
          | null
          | undefined;
        if (!payload || typeof payload.to !== 'string' || typeof payload.subject !== 'string' || typeof payload.body !== 'string') {
          throw new Error(
            `Cannot retry ${effect.effectType}: missing or invalid stored payload`,
          );
        }
        // Therapist-nudge has no appointment context, so we enqueue
        // without one. The email-queue accepts that — the appointmentId
        // is optional and only used for status linkage.
        await emailQueueService.enqueue({
          to: payload.to,
          subject: payload.subject,
          body: payload.body,
        });
        break;
      }

      default:
        throw new Error(`Unknown therapist-scoped side effect type: ${effect.effectType}`);
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
