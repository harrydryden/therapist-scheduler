/**
 * Weekly Mailing List Service
 *
 * Sends a "come book a session" email to subscribed users. Two trigger
 * conditions, evaluated on every periodic tick (≤1 hour latency):
 *
 *   1. **Event-triggered** — at least one therapist has become active
 *      since the last send. This fast-lane fires regardless of how many
 *      therapists are currently available, so new arrivals don't sit
 *      idle waiting for the threshold to be hit.
 *
 *   2. **Weekly cadence (threshold-gated)** — the directory holds at
 *      least `weeklyMailing.availableThreshold` bookable therapists.
 *      This is the steady-state "we still have capacity, come back" send.
 *
 * Both branches respect a once-per-7-days ceiling so back-to-back
 * therapist ingestions never produce back-to-back emails to the same user.
 *
 * The ceiling is only consumed by a run that actually delivered something:
 * if every send fails (broken Gmail credentials, open circuit breaker) the
 * last-send marker is left alone so the next hourly tick retries, and a
 * Slack alert fires. Marking unconditionally used to turn a transient
 * transport outage into an indefinite mailing outage, because the marker
 * also anchors the new-therapist event trigger. A mailing that goes
 * WEEKLY_MAILING.STALL_ALERT_AFTER_DAYS without sending alerts too — the
 * skip paths are otherwise invisible at production log level.
 *
 * Admins can also trigger a manual send from Admin Settings → Weekly
 * Mailing. The button shows a preview (recipient count + rendered body)
 * before confirming. forceSend() respects the 7-day ceiling by default;
 * pass `skipAlreadySentCheck=true` only from internal tooling that needs
 * to override it.
 *
 * Eligibility (per user) — all must be true:
 *   - Subscribed
 *   - Has no upcoming confirmed appointment
 *   - At least one therapist is available platform-wide
 *
 * Voucher lifecycle is per-recipient and orthogonal to the trigger:
 * the voucher section is rendered inside sendWeeklyEmail() based on
 * each user's VoucherTracking row.
 */

import { config } from '../config';
import { logger } from '../utils/logger';
import { redis } from '../utils/redis';
import { prisma } from '../utils/database';
import { LockedPeriodicService } from '../utils/locked-periodic-service';
import { therapistBookingStatusService } from './therapist-booking-status.service';
import { slackNotificationService } from './slack-notification.service';
import { sendEmail } from '../core/email';
import { getSettingValue, getSettingValues } from './settings.service';
import { renderTemplate, TemplateVariables } from '../utils/email-templates';
import { generateUnsubscribeUrl } from '../utils/unsubscribe-token';
import { generateVoucherUrl } from '../utils/voucher-token';
import { renderVoucherSection, formatVoucherExpiry } from '../utils/voucher-section';
import { firstName } from '../utils/first-name';
import { WEEKLY_MAILING, APPOINTMENT_STATUS } from '../constants';

/**
 * Postgres-backed projection of a mailing-list user. Replaces the
 * NotionUser type the service used to consume.
 */
interface MailingListUser {
  /** Postgres user uuid — used for the unsubscribe write. */
  id: string;
  email: string;
  name: string;
}

/**
 * Postgres-backed projection of a therapist used by the weekly mailing.
 */
interface MailingListTherapist {
  /** Public handle: notionId for legacy rows, Postgres uuid for newer rows. */
  id: string;
  name: string;
  areasOfFocus: string[];
}

/** Result of the trigger-evaluation step. */
type SendDecision =
  | { shouldSend: true; reason: 'new-therapist' | 'threshold' }
  | { shouldSend: false; reason: 'no-therapists' | 'no-trigger' };

const CHECK_INTERVAL_MS = WEEKLY_MAILING.CHECK_INTERVAL_MS;

// FIX L2: Retry configuration for failed checks
const RETRY_CONFIG = {
  MAX_RETRIES: 3,
  BASE_DELAY_MS: 5000, // 5 seconds
  MAX_DELAY_MS: 30000, // 30 seconds
};

class WeeklyMailingListService extends LockedPeriodicService {
  private consecutiveFailures = 0;

  constructor() {
    super({
      name: 'weekly-mailing',
      intervalMs: CHECK_INTERVAL_MS,
      lockKey: WEEKLY_MAILING.LOCK_KEY,
      lockTtlSeconds: WEEKLY_MAILING.LOCK_TTL_SECONDS,
      renewalIntervalMs: WEEKLY_MAILING.RENEWAL_INTERVAL_MS,
    });
  }

  protected async tick(ctx: { isLockValid: () => boolean }): Promise<void> {
    await this.checkAndSendWeeklyEmail(ctx.isLockValid);
    // FIX L2: Reset failure counter on success
    this.consecutiveFailures = 0;
  }

  /**
   * On error, schedule a retry with exponential backoff up to MAX_RETRIES.
   * The base class already logged the failure; we just decide whether to retry.
   */
  protected onError(err: Error): void {
    this.consecutiveFailures++;
    const shouldRetry = this.consecutiveFailures <= RETRY_CONFIG.MAX_RETRIES;
    const backoffDelay = Math.min(
      RETRY_CONFIG.BASE_DELAY_MS * Math.pow(2, this.consecutiveFailures - 1),
      RETRY_CONFIG.MAX_DELAY_MS
    );

    logger.error(
      { error: err, consecutiveFailures: this.consecutiveFailures, willRetry: shouldRetry, backoffMs: backoffDelay },
      'Error in weekly mailing check'
    );

    if (shouldRetry) {
      setTimeout(() => {
        logger.info({ attempt: this.consecutiveFailures + 1 }, 'Retrying weekly mailing check');
        void this.trigger();
      }, backoffDelay);
    }
  }

  /**
   * Force send the email to all eligible users. Used by the admin
   * "Send to users now" button and the legacy /trigger endpoint.
   *
   * Respects the enabled flag and the 7-day ceiling by default; pass
   * `skipAlreadySentCheck=true` only from internal tooling that has
   * already vetted the call.
   *
   * Unlike the periodic tick, this skips the event/threshold gate —
   * the admin has decided to send.
   */
  async forceSend(skipAlreadySentCheck: boolean = false): Promise<{ sent: number; failed: number; total: number }> {
    const checkId = `force-${Date.now().toString(36)}`;
    logger.info({ checkId, skipAlreadySentCheck }, 'Force sending weekly mailing');

    const enabled = await getSettingValue<boolean>('weeklyMailing.enabled');
    if (!enabled) {
      logger.warn({ checkId }, 'Weekly mailing is disabled - enable it first');
      throw new Error('Weekly mailing is disabled. Enable it in settings first.');
    }

    if (!skipAlreadySentCheck && await this.hasAlreadySentThisWeek()) {
      logger.warn({ checkId }, 'Weekly email already sent this week');
      throw new Error('Email already sent this week. Wait for the 7-day window to pass or use skipAlreadySentCheck.');
    }

    // Availability gate. The weekly email exists to drive bookings, so it must
    // not go out when the directory has no bookable therapist. The periodic
    // tick enforces this via evaluateSendDecision (`no-therapists`); forceSend
    // must too, otherwise the admin "Send now" button silently bypasses the
    // invariant and emails users to a directory they can't book from.
    const availableTherapists = await this.getAvailableTherapists();
    if (availableTherapists.length === 0) {
      logger.warn({ checkId }, 'No available therapists — refusing to force-send weekly mailing');
      throw new Error('No available therapists right now — the weekly email is not sent when there are no bookable therapists on the site.');
    }

    const users = await this.getEligibleUsers();
    if (users.length === 0) {
      logger.info({ checkId }, 'No eligible users for weekly mailing');
      return { sent: 0, failed: 0, total: 0 };
    }

    logger.info({ checkId, userCount: users.length }, 'Force sending weekly emails');

    const emailSettings = await this.fetchEmailSettings();

    let sent = 0;
    let failed = 0;
    for (const user of users) {
      try {
        await this.sendWeeklyEmail(user, emailSettings);
        sent++;
      } catch (error) {
        logger.error({ error, email: user.email }, 'Failed to send weekly email to user');
        failed++;
      }
    }

    // Same rule as the periodic tick: a run where nothing got out must not
    // consume the 7-day window or the new-therapist trigger. Without this an
    // admin pressing "Send now" during a Gmail outage would lock the mailing
    // out for a week while appearing to have sent.
    if (sent > 0) {
      await this.markAsSent();
    } else {
      logger.error(
        { checkId, failed, total: users.length },
        'Force weekly mailing sent nothing — every send failed. Not marking as sent',
      );
      await this.alertSendFailure(checkId, users.length);
    }

    logger.info({ checkId, sent, failed, total: users.length }, 'Force weekly mailing complete');
    return { sent, failed, total: users.length };
  }

  /**
   * Build a preview of the next send for the admin UI: how many users
   * would receive it, plus the rendered subject and body.
   *
   * Voucher section is rendered in its "new voucher" form because
   * that's what a fresh recipient would see — the actual per-user
   * reminder/strike variations aren't visualised. Goal is to show the
   * shape of the message, not predict every recipient's variant.
   */
  async previewSend(): Promise<{
    enabled: boolean;
    recipientCount: number;
    subjectPreview: string;
    bodyPreview: string;
  }> {
    const enabled = (await getSettingValue<boolean>('weeklyMailing.enabled')) ?? false;
    const emailSettings = await this.fetchEmailSettings();
    const users = await this.getEligibleUsers();

    const placeholderName = 'there';
    const voucherSection = emailSettings.voucherEnabled
      ? renderVoucherSection({
          isReminder: false,
          voucherExpiry: formatVoucherExpiry(
            new Date(Date.now() + emailSettings.voucherExpiryDays * 24 * 60 * 60 * 1000),
          ),
        })
      : '';

    const subjectPreview = renderTemplate(emailSettings.subjectTemplate, { userName: placeholderName });
    const bodyPreview = renderUnifiedBody(
      emailSettings.bodyTemplate,
      {
        userName: placeholderName,
        webAppUrl: emailSettings.webAppUrl,
        unsubscribeUrl: '<unique unsubscribe link per recipient>',
      },
      voucherSection,
    );

    return {
      enabled,
      recipientCount: users.length,
      subjectPreview,
      bodyPreview,
    };
  }

  /**
   * Main check function — runs every CHECK_INTERVAL_MS under a
   * distributed lock. Honours the once-per-7-days ceiling and only
   * proceeds if a trigger condition is satisfied (new therapist
   * since last send, or available count ≥ threshold).
   */
  private async checkAndSendWeeklyEmail(isLockValid: () => boolean): Promise<void> {
    const checkId = Date.now().toString(36);
    logger.info({ checkId }, 'Running weekly mailing check');

    const enabled = await getSettingValue<boolean>('weeklyMailing.enabled');
    if (!enabled) {
      logger.debug({ checkId }, 'Weekly mailing is disabled');
      return;
    }

    if (await this.hasAlreadySentThisWeek()) {
      logger.debug({ checkId }, 'Weekly email already sent this week');
      return;
    }

    // Every path below this point is a reason the promo email did NOT go
    // out. They were previously logged at debug, so at production log level
    // a mailing that silently stopped emitted nothing at all — the failure
    // mode this service actually hit. They are info now, and an overdue
    // mailing additionally raises a Slack alert (throttled to once a day).
    const decision = await this.evaluateSendDecision();
    if (!decision.shouldSend) {
      logger.info({ checkId, reason: decision.reason }, 'Not sending — trigger conditions not met');
      await this.alertIfSendOverdue(checkId, `trigger conditions not met (${decision.reason})`);
      return;
    }

    const users = await this.getEligibleUsers();
    if (users.length === 0) {
      // Genuinely nobody to email (getEligibleUsers throws on failure, so
      // this is not masking an error). Marking as sent is safe here and
      // stops the check re-running every hour for the next week.
      logger.info({ checkId, trigger: decision.reason }, 'No eligible users — marking as sent to avoid rechecking every hour');
      await this.markAsSent();
      await this.alertIfSendOverdue(checkId, 'no eligible users on the mailing list');
      return;
    }

    logger.info({ checkId, trigger: decision.reason, userCount: users.length }, 'Sending weekly emails');

    const emailSettings = await this.fetchEmailSettings();

    let sent = 0;
    let failed = 0;

    for (const user of users) {
      if (!isLockValid()) {
        logger.warn({ checkId, sent, failed, remaining: users.length - sent - failed }, 'Aborting weekly mailing - lock lost');
        break;
      }
      try {
        await this.sendWeeklyEmail(user, emailSettings);
        sent++;
      } catch (error) {
        logger.error({ error, email: user.email }, 'Failed to send weekly email to user');
        failed++;
      }
    }

    // Only record a send when at least one email actually got out.
    //
    // This marker drives BOTH the 7-day ceiling and the "new therapists
    // since last send" event trigger (countNewTherapistsSince keys on
    // `ingestedAt > lastSentAt`). Marking unconditionally meant a total
    // send failure — Gmail credentials broken, circuit breaker open —
    // silently bought a week of quiet AND consumed the fast lane for every
    // therapist ingested beforehand, then repeated the next week. A
    // transient outage became a permanent one.
    //
    // Leaving the marker untouched lets the next hourly tick retry. A
    // partial success still marks: the alternative is re-emailing the
    // recipients who already received it.
    if (sent > 0) {
      await this.markAsSent();
    } else {
      logger.error(
        { checkId, failed, total: users.length, trigger: decision.reason },
        'Weekly mailing sent nothing — every send failed. Not marking as sent; will retry on the next tick',
      );
      await this.alertSendFailure(checkId, users.length);
    }

    logger.info({ checkId, sent, failed, total: users.length, trigger: decision.reason }, 'Weekly mailing complete');
  }

  /**
   * Decide whether the periodic tick should send. Two ways to qualify:
   *
   *   - **new-therapist**: ≥1 active therapist with `ingestedAt > lastSentAt`.
   *     This is the event-triggered fast lane.
   *   - **threshold**: the available count meets `weeklyMailing.availableThreshold`.
   *
   * If the directory is empty we always skip.
   *
   * NOTE: callers must have already verified the 7-day ceiling
   * (hasAlreadySentThisWeek). This method only decides "given that
   * we're allowed to send, do we want to?".
   */
  private async evaluateSendDecision(): Promise<SendDecision> {
    const [availableTherapists, thresholdRaw, lastSentAt] = await Promise.all([
      this.getAvailableTherapists(),
      getSettingValue<number>('weeklyMailing.availableThreshold'),
      this.getLastSentAt(),
    ]);

    if (availableTherapists.length === 0) {
      return { shouldSend: false, reason: 'no-therapists' };
    }

    const newCount = await this.countNewTherapistsSince(lastSentAt);
    if (newCount > 0) {
      return { shouldSend: true, reason: 'new-therapist' };
    }

    const threshold = thresholdRaw ?? 5;
    if (availableTherapists.length >= threshold) {
      return { shouldSend: true, reason: 'threshold' };
    }

    return { shouldSend: false, reason: 'no-trigger' };
  }

  /**
   * Count therapists who became active since the last send. First-ever
   * run (lastSentAt=null) treats every therapist with a known
   * ingestedAt as new — that's the initial "platform launch" send.
   *
   * Legacy rows with ingestedAt=null don't contribute to the event
   * trigger (they predate the trigger mechanism); the threshold path
   * still picks them up.
   */
  private async countNewTherapistsSince(lastSentAt: Date | null): Promise<number> {
    try {
      return await prisma.therapist.count({
        where: {
          active: true,
          ingestedAt: lastSentAt ? { gt: lastSentAt } : { not: null },
        },
      });
    } catch (error) {
      logger.warn({ error }, 'Failed to count new therapists since last send');
      return 0;
    }
  }

  /**
   * Read the last-sent timestamp from Redis. Returns null if never sent
   * or if the key has expired (90-day TTL).
   */
  private async getLastSentAt(): Promise<Date | null> {
    // getStrict: a Redis failure must surface as an error, not as "never
    // sent". The lenient wrapper returned null on failure, which made
    // countNewTherapistsSince treat every therapist as new and re-blast
    // the entire list on every hourly tick for as long as Redis was down.
    const str = await redis.getStrict(WEEKLY_MAILING.LAST_SEND_KEY);
    if (!str) return null;
    const dt = new Date(str);
    return isNaN(dt.getTime()) ? null : dt;
  }

  /**
   * Check if we've already sent the weekly email this week
   *
   * FIX: Uses UTC date-only comparison to prevent DST-related issues.
   * During DST transitions (especially fall-back), comparing elapsed time
   * with milliseconds could allow double-sends (23h or 25h days).
   *
   * Solution: Count calendar days using UTC dates only, ignoring time component.
   */
  private async hasAlreadySentThisWeek(): Promise<boolean> {
    try {
      const lastSendStr = await redis.getStrict(WEEKLY_MAILING.LAST_SEND_KEY);
      if (!lastSendStr) return false;

      // Extract UTC date components (ignore time to avoid DST issues)
      const lastSend = new Date(lastSendStr);
      const now = new Date();

      // Get UTC dates as YYYY-MM-DD strings for comparison
      const lastSendDate = lastSendStr.split('T')[0]; // e.g., "2024-01-15"
      const todayDate = now.toISOString().split('T')[0];

      // If sent today, definitely skip
      if (lastSendDate === todayDate) {
        return true;
      }

      // FIX: Count calendar days using UTC dates only
      // This avoids DST issues where a day might be 23h or 25h
      const lastSendUTC = Date.UTC(
        lastSend.getUTCFullYear(),
        lastSend.getUTCMonth(),
        lastSend.getUTCDate()
      );
      const nowUTC = Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate()
      );

      // Calculate days difference using UTC midnight-to-midnight
      const daysDiff = Math.floor((nowUTC - lastSendUTC) / (1000 * 60 * 60 * 24));
      return daysDiff < WEEKLY_MAILING.MIN_INTERVAL_DAYS - 1;
    } catch (error) {
      // FAIL SAFE: if the only send-once guard can't be read, assume we
      // already sent. Skipping a week is recoverable; mailing every
      // subscriber again every hour is not.
      logger.error(
        { error },
        'Weekly mailing: last-send guard unreadable (Redis) — treating as already sent this week',
      );
      return true;
    }
  }

  /**
   * Mark that we've sent the weekly email
   */
  private async markAsSent(): Promise<void> {
    try {
      await redis.set(
        WEEKLY_MAILING.LAST_SEND_KEY,
        new Date().toISOString(),
        'EX',
        WEEKLY_MAILING.LAST_SEND_TTL_SECONDS,
      );
    } catch (error) {
      logger.error({ error }, 'Failed to mark weekly email as sent');
    }
  }

  /**
   * Once-per-day gate for the mailing-health alerts. The generic Slack
   * dedup window is only ~2 minutes, and these checks run hourly, so
   * without this an ongoing problem would alert 24 times a day.
   *
   * Fails CLOSED (returns false, no alert) when Redis is unavailable —
   * a broken cache must not turn into an alert storm.
   */
  private async shouldAlertNow(key: string, ttlSeconds: number): Promise<boolean> {
    try {
      return await redis.acquireLock(key, new Date().toISOString(), ttlSeconds);
    } catch (error) {
      logger.warn({ error, key }, 'Could not check mailing alert throttle — suppressing alert');
      return false;
    }
  }

  /**
   * Alert when the promo email is overdue: a skip on its own is normal
   * (the 7-day window, a quiet week), but going STALL_ALERT_AFTER_DAYS
   * without a send means the mailing has stopped and nobody was told.
   * This is the gap that let a 10-day outage pass unnoticed.
   *
   * lastSentAt of null is not treated as overdue: it means "never sent"
   * or an expired key, both of which make the next tick send rather than
   * stall, so alerting would be noise on a fresh environment.
   */
  private async alertIfSendOverdue(checkId: string, reason: string): Promise<void> {
    try {
      const lastSentAt = await this.getLastSentAt();
      if (!lastSentAt) return;

      const daysSince = Math.floor((Date.now() - lastSentAt.getTime()) / (24 * 60 * 60 * 1000));
      if (daysSince < WEEKLY_MAILING.STALL_ALERT_AFTER_DAYS) return;

      if (!(await this.shouldAlertNow(WEEKLY_MAILING.STALL_ALERT_KEY, WEEKLY_MAILING.STALL_ALERT_TTL_SECONDS))) {
        return;
      }

      logger.warn({ checkId, daysSince, reason }, 'Weekly mailing overdue — alerting');
      await slackNotificationService.sendAlert({
        title: 'Weekly Mailing Overdue',
        severity: 'medium',
        details:
          `The promotional weekly email has not gone out for ${daysSince} days ` +
          `(expected every ${WEEKLY_MAILING.MIN_INTERVAL_DAYS}). Latest check skipped: ${reason}.`,
        additionalFields: {
          'Days since last send': String(daysSince),
          'Skip reason': reason,
          'Check ID': checkId,
        },
      });
    } catch (error) {
      logger.warn({ error, checkId }, 'Failed to raise weekly-mailing overdue alert');
    }
  }

  /**
   * Alert when a send ran but every single email failed — the signature of
   * a broken transport (Gmail credentials, open circuit breaker) rather
   * than a gating decision. Distinct from the overdue alert because this
   * one is actionable immediately and does not wait for the day threshold.
   */
  private async alertSendFailure(checkId: string, attempted: number): Promise<void> {
    try {
      if (!(await this.shouldAlertNow(WEEKLY_MAILING.STALL_ALERT_KEY + ':failure', WEEKLY_MAILING.STALL_ALERT_TTL_SECONDS))) {
        return;
      }
      await slackNotificationService.sendAlert({
        title: 'Weekly Mailing Send Failed',
        severity: 'high',
        details:
          `All ${attempted} weekly promo emails failed to send. Nothing was delivered and the ` +
          `send window was NOT consumed, so the next hourly tick will retry. Check Gmail ` +
          `credentials and the Gmail circuit breaker (GET /api/admin/gmail/status).`,
        additionalFields: {
          'Recipients attempted': String(attempted),
          'Check ID': checkId,
        },
      });
    } catch (error) {
      logger.warn({ error, checkId }, 'Failed to raise weekly-mailing send-failure alert');
    }
  }

  /**
   * Get all currently available therapists (active and not frozen/booked).
   * Reads from Postgres now that Notion is no longer authoritative.
   */
  private async getAvailableTherapists(): Promise<MailingListTherapist[]> {
    const [rows, unavailableIds] = await Promise.all([
      prisma.therapist.findMany({
        where: { active: true },
        select: { id: true, notionId: true, name: true, areasOfFocus: true },
      }),
      therapistBookingStatusService.getUnavailableTherapistIds(),
    ]);
    const unavailableSet = new Set(unavailableIds);

    return rows
      .map((t) => ({
        id: t.notionId ?? t.id,
        name: t.name,
        areasOfFocus: t.areasOfFocus,
      }))
      .filter((t) => !unavailableSet.has(t.id));
  }

  /**
   * Get users eligible for the weekly mailing: subscribed and with no
   * confirmed upcoming appointment. Reads from Postgres now that the
   * Notion users database has been retired.
   *
   * THROWS on query failure — deliberately. This used to swallow the error
   * and return [], which the caller could not distinguish from "nobody is
   * eligible": it logged "No eligible users", called markAsSent(), and
   * burned a week of the cadence on a transient database blip. Callers must
   * see the failure, so an empty array now means genuinely zero recipients.
   */
  private async getEligibleUsers(): Promise<MailingListUser[]> {
    try {
      const now = new Date();

      // Users with at least one upcoming confirmed appointment (we exclude
      // these from the mailing list — they don't need a voucher).
      const usersWithUpcoming = await prisma.appointmentRequest.findMany({
        where: {
          status: APPOINTMENT_STATUS.CONFIRMED,
          confirmedDateTimeParsed: { gt: now },
          userId: { not: null },
        },
        select: { userId: true },
        distinct: ['userId'],
      });
      const excludedIds = usersWithUpcoming
        .map((a) => a.userId)
        .filter((id): id is string => id !== null);

      const rows = await prisma.user.findMany({
        where: {
          subscribed: true,
          ...(excludedIds.length > 0 ? { id: { notIn: excludedIds } } : {}),
        },
        select: { id: true, email: true, name: true },
      });

      return rows.map((u) => ({
        id: u.id,
        email: u.email,
        name: u.name ?? 'there',
      }));
    } catch (error) {
      logger.error({ error }, 'Failed to get eligible mailing list users');
      throw error instanceof Error
        ? error
        : new Error('Failed to get eligible mailing list users');
    }
  }

  /**
   * Fetch email template settings once (call before the send loop, not per-user)
   */
  private async fetchEmailSettings(): Promise<EmailSettings> {
    const settingsMap = await getSettingValues([
      'email.weeklyMailingSubject',
      'email.weeklyMailingBody',
      'email.voucherFinalNoticeSubject',
      'email.voucherFinalNoticeBody',
      'weeklyMailing.webAppUrl',
      'voucher.enabled',
      'voucher.expiryDays',
      'voucher.maxStrikes',
      'voucher.autoUnsubscribeEnabled',
    ]);
    return {
      subjectTemplate: settingsMap.get('email.weeklyMailingSubject') as string,
      bodyTemplate: settingsMap.get('email.weeklyMailingBody') as string,
      finalNoticeSubjectTemplate: settingsMap.get('email.voucherFinalNoticeSubject') as string,
      finalNoticeBodyTemplate: settingsMap.get('email.voucherFinalNoticeBody') as string,
      webAppUrl: settingsMap.get('weeklyMailing.webAppUrl') as string,
      voucherEnabled: settingsMap.get('voucher.enabled') as boolean,
      voucherExpiryDays: settingsMap.get('voucher.expiryDays') as number,
      voucherMaxStrikes: settingsMap.get('voucher.maxStrikes') as number,
      // Explicit === true: this gate removes people from the list, so an
      // undefined/failed lookup must fail SAFE (keep the user subscribed).
      voucherAutoUnsubscribeEnabled: settingsMap.get('voucher.autoUnsubscribeEnabled') === true,
    };
  }

  /**
   * Send weekly email to a single user.
   *
   * Produces a single unified email with the voucher section — either
   * a new code or a reminder about an existing one. The voucher code
   * is never shown as text; it is only embedded in the booking URL.
   *
   * Voucher lifecycle (use-it-or-lose-it):
   * - No tracking or expired-and-used: issue new code
   * - Active unused voucher: send reminder for the existing code
   * - Voucher was used: reward with a fresh code (resets strike counter)
   * - After N consecutive expired codes: auto-unsubscribe with final notice
   *   — ONLY when `voucher.autoUnsubscribeEnabled` is on (off by default);
   *   otherwise the user keeps their spot and receives a fresh code
   */
  private async sendWeeklyEmail(
    user: MailingListUser,
    emailSettings: EmailSettings,
  ): Promise<void> {
    const unsubscribeUrl = generateUnsubscribeUrl(user.email, config.backendUrl);

    if (!emailSettings.voucherEnabled) {
      await this.renderAndSend(user, emailSettings, {
        webAppUrl: emailSettings.webAppUrl,
        unsubscribeUrl,
        voucherSection: '',
      });
      logger.info({ email: user.email }, 'Sent weekly mailing email (no voucher)');
      return;
    }

    const emailLower = user.email.toLowerCase();
    const { voucherExpiryDays: expiryDays, voucherMaxStrikes: maxStrikes, webAppUrl } = emailSettings;

    let tracking = await prisma.voucherTracking.findUnique({ where: { id: emailLower } });
    const now = new Date();
    const hasActiveVoucher = tracking?.lastVoucherSentAt &&
      (now.getTime() - tracking.lastVoucherSentAt.getTime()) < expiryDays * 24 * 60 * 60 * 1000;
    const voucherUsed = tracking?.lastVoucherUsedAt && tracking?.lastVoucherSentAt &&
      tracking.lastVoucherUsedAt > tracking.lastVoucherSentAt;

    // Reminder path: active voucher still unused
    if (hasActiveVoucher && !voucherUsed && tracking?.lastVoucherToken) {
      const expiresAt = new Date(tracking.lastVoucherSentAt!.getTime() + expiryDays * 24 * 60 * 60 * 1000);
      const daysRemaining = Math.ceil((expiresAt.getTime() - now.getTime()) / (24 * 60 * 60 * 1000));
      const separator = webAppUrl.includes('?') ? '&' : '?';
      const voucherWebAppUrl = `${webAppUrl}${separator}voucher=${encodeURIComponent(tracking.lastVoucherToken)}`;

      await this.renderAndSend(user, emailSettings, {
        webAppUrl: voucherWebAppUrl,
        unsubscribeUrl,
        voucherSection: renderVoucherSection({ isReminder: true, voucherExpiry: formatVoucherExpiry(expiresAt), daysRemaining }),
      });

      await prisma.voucherTracking.update({
        where: { id: emailLower },
        data: { reminderSentAt: now },
      });
      logger.info({ email: emailLower }, 'Sent weekly email with voucher reminder');
      return;
    }

    // Strike/reset bookkeeping before issuing a new voucher
    if (hasActiveVoucher && !voucherUsed && tracking && !tracking.lastVoucherToken) {
      logger.warn({ email: emailLower }, 'Voucher tracking has no stored token, issuing new one');
    } else if (tracking?.lastVoucherSentAt && !voucherUsed && !hasActiveVoucher) {
      const newStrikeCount = (tracking.strikeCount || 0) + 1;
      if (newStrikeCount >= maxStrikes) {
        // Freeing up the user's spot is opt-in. When the toggle is off the
        // user keeps their subscription and gets a fresh code like any
        // other strike week — no final notice. Strikes keep counting for
        // visibility, so if the toggle is later enabled, the next expired
        // voucher (not this historical tally alone) triggers the notice.
        if (emailSettings.voucherAutoUnsubscribeEnabled) {
          await this.sendFinalNoticeAndUnsubscribe(user, emailSettings, unsubscribeUrl, tracking, newStrikeCount);
          return;
        }
        logger.info(
          { email: emailLower, strikeCount: newStrikeCount, maxStrikes },
          'Max voucher strikes reached but auto-unsubscribe is disabled - keeping user subscribed'
        );
      }
      tracking = { ...tracking, strikeCount: newStrikeCount };
      logger.info({ email: emailLower, strikeCount: newStrikeCount, maxStrikes }, 'Voucher expired unused, strike incremented');
    } else if (voucherUsed && tracking) {
      tracking = { ...tracking, strikeCount: 0 };
      logger.info({ email: emailLower }, 'Voucher was used, strike count reset');
    }

    await this.sendNewVoucherEmail(user, emailSettings, unsubscribeUrl, tracking);
  }

  /**
   * Issue a new voucher and send it via the unified template.
   *
   * The DB upsert happens BEFORE email send so a crash mid-send leaves an
   * active unused voucher (next run sends a reminder) rather than losing the
   * record entirely. The upsert also folds in the caller's strikeCount so the
   * strike increment/reset is atomic with the new-voucher persist.
   */
  private async sendNewVoucherEmail(
    user: MailingListUser,
    emailSettings: EmailSettings,
    unsubscribeUrl: string,
    tracking: { id: string; strikeCount: number } | null,
  ): Promise<void> {
    const emailLower = user.email.toLowerCase();
    const voucherResult = generateVoucherUrl(emailLower, emailSettings.webAppUrl, emailSettings.voucherExpiryDays);

    const now = new Date();
    const strikeCount = tracking?.strikeCount ?? 0;
    const upsertData = {
      lastVoucherSentAt: now,
      lastVoucherToken: voucherResult.token,
      strikeCount,
      reminderSentAt: null,
    };
    await prisma.voucherTracking.upsert({
      where: { id: emailLower },
      create: { id: emailLower, ...upsertData },
      update: upsertData,
    });

    await this.renderAndSend(user, emailSettings, {
      webAppUrl: voucherResult.url,
      unsubscribeUrl,
      voucherSection: renderVoucherSection({ isReminder: false, voucherExpiry: formatVoucherExpiry(voucherResult.expiresAt) }),
    });

    logger.info(
      { email: emailLower, expiresAt: voucherResult.expiresAt.toISOString() },
      'Sent weekly email with new voucher'
    );
  }

  /**
   * Render the unified weekly email and send it. Single render+send call site
   * shared by the no-voucher, reminder, and new-voucher flows.
   */
  private async renderAndSend(
    user: MailingListUser,
    emailSettings: EmailSettings,
    sections: {
      webAppUrl: string;
      unsubscribeUrl: string;
      voucherSection: string;
    },
  ): Promise<void> {
    const userFirstName = firstName(user.name);
    const subject = renderTemplate(emailSettings.subjectTemplate, { userName: userFirstName });
    const body = renderUnifiedBody(
      emailSettings.bodyTemplate,
      { userName: userFirstName, webAppUrl: sections.webAppUrl, unsubscribeUrl: sections.unsubscribeUrl },
      sections.voucherSection,
    );
    await sendEmail({ to: user.email, subject, body });
  }

  /**
   * Send final notice email and auto-unsubscribe the user
   */
  private async sendFinalNoticeAndUnsubscribe(
    user: MailingListUser,
    emailSettings: EmailSettings,
    unsubscribeUrl: string,
    tracking: { id: string; strikeCount: number },
    newStrikeCount: number,
  ): Promise<void> {
    const emailLower = user.email.toLowerCase();

    // Send final notice email
    const userFirstName = firstName(user.name);
    const subject = renderTemplate(emailSettings.finalNoticeSubjectTemplate, { userName: userFirstName });
    const body = renderTemplate(emailSettings.finalNoticeBodyTemplate, {
      userName: userFirstName,
      unsubscribeUrl,
    });

    await sendEmail({ to: user.email, subject, body });

    // Update tracking with final strike count and unsubscribe timestamp
    const now = new Date();
    await prisma.voucherTracking.update({
      where: { id: emailLower },
      data: {
        strikeCount: newStrikeCount,
        unsubscribedAt: now,
        lastVoucherToken: null,
      },
    });

    // Unsubscribe from the mailing list. Postgres is now the source of
    // truth — the previous Notion mirror has been retired.
    try {
      await prisma.user.update({
        where: { id: user.id },
        data: { subscribed: false },
      });
      logger.info(
        { email: emailLower, strikeCount: newStrikeCount },
        'Auto-unsubscribed user after consecutive expired vouchers'
      );
    } catch (error) {
      logger.error(
        { error, email: emailLower },
        'Failed to auto-unsubscribe user (voucher tracking updated)'
      );
    }
  }
}

// ============================================
// Types and Helpers
// ============================================

interface EmailSettings {
  subjectTemplate: string;
  bodyTemplate: string;
  finalNoticeSubjectTemplate: string;
  finalNoticeBodyTemplate: string;
  webAppUrl: string;
  voucherEnabled: boolean;
  voucherExpiryDays: number;
  voucherMaxStrikes: number;
  voucherAutoUnsubscribeEnabled: boolean;
}

/**
 * Render the unified weekly email body.
 *
 * The two-pass design avoids double-escaping the system-generated voucher
 * section: renderTemplate HTML-escapes its variables, but the email body is
 * also passed through convertToHtml downstream which escapes again. So we
 * render user-supplied variables via renderTemplate (escaped once) and
 * inject the voucher section via plain replacement (escaped only by
 * convertToHtml).
 *
 * `{newTherapistsSection}` is kept as a no-op substitution so any
 * customer-customised template that still references it keeps rendering
 * cleanly — the section itself was retired when the trigger model moved
 * from "weekly digest of new arrivals" to "we have therapists, come book".
 */
function renderUnifiedBody(
  template: string,
  variables: TemplateVariables,
  voucherSection: string,
): string {
  return renderTemplate(template, variables)
    .replace(/\{newTherapistsSection\}/g, '')
    .replace(/\{voucherSection\}/g, voucherSection);
}

export const weeklyMailingListService = new WeeklyMailingListService();
