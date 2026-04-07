/**
 * Weekly Mailing List Service
 *
 * Sends automated weekly promotional emails to subscribed users
 * when at least one therapist is available for booking.
 *
 * Eligibility criteria (all must be true):
 * - User is subscribed (Notion Users database)
 * - User has no upcoming appointments
 * - At least one therapist is available (Active + not frozen)
 *
 * Features:
 * - Configurable send day/time via admin settings
 * - Uses LockedTaskRunner for distributed lock management
 * - Tracks last send date to prevent duplicate sends
 * - Includes personalized unsubscribe links
 */

import { config } from '../config';
import { logger } from '../utils/logger';
import { redis } from '../utils/redis';
import { prisma } from '../utils/database';
import { LockedTaskRunner } from '../utils/locked-task-runner';
import { notionUsersService, NotionUser } from './notion-users.service';
import { notionService, InternalTherapist } from './notion.service';
import { therapistBookingStatusService } from './therapist-booking-status.service';
import { emailProcessingService } from './email-processing.service';
import { getSettingValue, getSettingValues } from './settings.service';
import { renderTemplate, TemplateVariables } from '../utils/email-templates';
import { generateUnsubscribeUrl } from '../utils/unsubscribe-token';
import { generateVoucherUrl } from '../utils/voucher-token';
import { safeJsonParse } from '../utils/json-parser';
import { WEEKLY_MAILING } from '../constants';

// Check interval: every hour
const CHECK_INTERVAL_MS = WEEKLY_MAILING.CHECK_INTERVAL_MS;

// FIX L2: Retry configuration for failed checks
const RETRY_CONFIG = {
  MAX_RETRIES: 3,
  BASE_DELAY_MS: 5000, // 5 seconds
  MAX_DELAY_MS: 30000, // 30 seconds
};

class WeeklyMailingListService {
  private intervalId: NodeJS.Timeout | null = null;
  private instanceId: string;
  private lockedRunner: LockedTaskRunner;
  private consecutiveFailures = 0;

  constructor() {
    this.instanceId = `${process.pid}-${Date.now().toString(36)}-weekly`;

    this.lockedRunner = new LockedTaskRunner({
      lockKey: WEEKLY_MAILING.LOCK_KEY,
      lockTtlSeconds: WEEKLY_MAILING.LOCK_TTL_SECONDS,
      renewalIntervalMs: WEEKLY_MAILING.RENEWAL_INTERVAL_MS,
      instanceId: this.instanceId,
      context: 'weekly-mailing',
    });
  }

  /**
   * Start the periodic weekly mailing check
   */
  start(): void {
    if (this.intervalId) {
      logger.warn('Weekly mailing list service already running');
      return;
    }

    logger.info('Starting weekly mailing list service (checks every hour)');

    // Run immediately on startup
    this.runSafeCheck();

    // Then run every hour
    this.intervalId = setInterval(() => {
      this.runSafeCheck();
    }, CHECK_INTERVAL_MS);
  }

  /**
   * Stop the periodic check
   */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      logger.info('Weekly mailing list service stopped');
    }
  }

  /**
   * Get service status for health checks
   */
  getStatus(): { running: boolean; intervalMs: number } {
    return {
      running: this.intervalId !== null,
      intervalMs: CHECK_INTERVAL_MS,
    };
  }

  /**
   * Safe wrapper that catches errors without crashing the interval.
   * Uses LockedTaskRunner for distributed lock management.
   */
  private async runSafeCheck(): Promise<void> {
    const taskResult = await this.lockedRunner.run(async (ctx) => {
      await this.checkAndSendWeeklyEmail(ctx.isLockValid);
    });

    if (!taskResult.acquired) {
      logger.debug('Another instance is handling weekly mailing, skipping');
      return;
    }

    if (taskResult.error) {
      // FIX L2: Implement retry with exponential backoff
      this.consecutiveFailures++;
      const shouldRetry = this.consecutiveFailures <= RETRY_CONFIG.MAX_RETRIES;
      const backoffDelay = Math.min(
        RETRY_CONFIG.BASE_DELAY_MS * Math.pow(2, this.consecutiveFailures - 1),
        RETRY_CONFIG.MAX_DELAY_MS
      );

      logger.error(
        { error: taskResult.error, consecutiveFailures: this.consecutiveFailures, willRetry: shouldRetry, backoffMs: backoffDelay },
        'Error in weekly mailing check'
      );

      if (shouldRetry) {
        setTimeout(() => {
          logger.info({ attempt: this.consecutiveFailures + 1 }, 'Retrying weekly mailing check');
          this.runSafeCheck();
        }, backoffDelay);
      }
      return;
    }

    // FIX L2: Reset failure counter on success
    this.consecutiveFailures = 0;
  }

  /**
   * Force send the weekly email to all eligible users
   * Bypasses the day/time check but still requires enabled flag
   * and checks if already sent this week (can be overridden)
   */
  async forceSend(skipAlreadySentCheck: boolean = false): Promise<{ sent: number; failed: number; total: number }> {
    const checkId = `force-${Date.now().toString(36)}`;
    logger.info({ checkId, skipAlreadySentCheck }, 'Force sending weekly mailing');

    // Check if enabled
    const enabled = await getSettingValue<boolean>('weeklyMailing.enabled');
    if (!enabled) {
      logger.warn({ checkId }, 'Weekly mailing is disabled - enable it first');
      throw new Error('Weekly mailing is disabled. Enable it in settings first.');
    }

    // Check if already sent this week (unless overridden)
    if (!skipAlreadySentCheck && await this.hasAlreadySentThisWeek()) {
      logger.warn({ checkId }, 'Weekly email already sent this week');
      throw new Error('Weekly email already sent this week. Wait until next week or use skipAlreadySentCheck.');
    }

    const availableTherapists = await this.getAvailableTherapists();
    const newTherapists = await this.getNewTherapists(availableTherapists);

    const users = await this.getEligibleUsers();
    if (users.length === 0) {
      logger.info({ checkId }, 'No eligible users for weekly mailing');
      return { sent: 0, failed: 0, total: 0 };
    }

    logger.info({ checkId, userCount: users.length, newTherapists: newTherapists.length }, 'Force sending weekly emails');

    const emailSettings = await this.fetchEmailSettings();
    const newTherapistsSection = this.buildNewTherapistsSection(newTherapists);

    let sent = 0;
    let failed = 0;
    for (const user of users) {
      try {
        await this.sendWeeklyEmail(user, emailSettings, newTherapistsSection);
        sent++;
      } catch (error) {
        logger.error({ error, email: user.email }, 'Failed to send weekly email to user');
        failed++;
      }
    }

    if (sent > 0) {
      await this.recordKnownTherapists(availableTherapists);
    }
    await this.markAsSent();

    logger.info({ checkId, sent, failed, total: users.length }, 'Force weekly mailing complete');
    return { sent, failed, total: users.length };
  }

  /**
   * Main check function - determines if it's time to send and processes eligible users.
   * Accepts isLockValid callback from LockedTaskRunner to abort if lock is lost mid-send.
   */
  private async checkAndSendWeeklyEmail(isLockValid: () => boolean): Promise<void> {
    const checkId = Date.now().toString(36);
    logger.info({ checkId }, 'Running weekly mailing check');

    // Check if enabled
    const enabled = await getSettingValue<boolean>('weeklyMailing.enabled');
    if (!enabled) {
      logger.debug({ checkId }, 'Weekly mailing is disabled');
      return;
    }

    // Check if it's the right day and hour
    if (!(await this.shouldSendNow())) {
      logger.debug({ checkId }, 'Not time to send weekly email');
      return;
    }

    // Check if already sent this week
    if (await this.hasAlreadySentThisWeek()) {
      logger.debug({ checkId }, 'Weekly email already sent this week');
      return;
    }

    // Get available therapists (also checks if any exist)
    const availableTherapists = await this.getAvailableTherapists();
    if (availableTherapists.length === 0) {
      logger.info({ checkId }, 'No therapists available - skipping weekly mailing');
      return;
    }

    // Determine which therapists are new since last email
    const newTherapists = await this.getNewTherapists(availableTherapists);

    // Get eligible users
    const users = await this.getEligibleUsers();
    if (users.length === 0) {
      logger.info({ checkId }, 'No eligible users for weekly mailing');
      // Still mark as sent to avoid rechecking every hour
      await this.markAsSent();
      return;
    }

    logger.info({ checkId, userCount: users.length, newTherapists: newTherapists.length }, 'Sending weekly emails');

    // Fetch email template settings once for the entire batch
    const emailSettings = await this.fetchEmailSettings();
    const newTherapistsSection = this.buildNewTherapistsSection(newTherapists);

    // Send emails
    let sent = 0;
    let failed = 0;

    for (const user of users) {
      // Abort if we lost the distributed lock mid-send
      if (!isLockValid()) {
        logger.warn({ checkId, sent, failed, remaining: users.length - sent - failed }, 'Aborting weekly mailing - lock lost');
        break;
      }
      try {
        await this.sendWeeklyEmail(user, emailSettings, newTherapistsSection);
        sent++;
      } catch (error) {
        logger.error({ error, email: user.email }, 'Failed to send weekly email to user');
        failed++;
      }
    }

    if (sent > 0) {
      await this.recordKnownTherapists(availableTherapists);
    }
    // Mark as sent for this week (even partial sends count to avoid double-send)
    await this.markAsSent();

    logger.info({ checkId, sent, failed, total: users.length }, 'Weekly mailing complete');
  }

  /**
   * Check if current time matches the configured send day and hour
   */
  private async shouldSendNow(): Promise<boolean> {
    // Batch fetch schedule settings in a single query
    const settingsMap = await getSettingValues([
      'weeklyMailing.sendDay',
      'weeklyMailing.sendHour',
      'general.timezone',
    ]);
    const sendDay = settingsMap.get('weeklyMailing.sendDay') as number;
    const sendHour = settingsMap.get('weeklyMailing.sendHour') as number;
    const timezone = settingsMap.get('general.timezone') as string;

    // Get current time in configured timezone
    const now = new Date();
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      weekday: 'short',
      hour: 'numeric',
      hour12: false,
    });

    const parts = formatter.formatToParts(now);
    const dayName = parts.find(p => p.type === 'weekday')?.value;
    const hour = parseInt(parts.find(p => p.type === 'hour')?.value || '0', 10);

    // Map day name to number
    const dayMap: Record<string, number> = {
      Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
    };
    const currentDay = dayMap[dayName || 'Mon'] ?? 1;

    return currentDay === sendDay && hour === sendHour;
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
      const lastSendStr = await redis.get(WEEKLY_MAILING.LAST_SEND_KEY);
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
      return daysDiff < 6;
    } catch (error) {
      logger.warn({ error }, 'Failed to check last send date');
      return false;
    }
  }

  /**
   * Mark that we've sent the weekly email
   */
  private async markAsSent(): Promise<void> {
    try {
      // Store for 8 days to cover week + buffer
      await redis.set(WEEKLY_MAILING.LAST_SEND_KEY, new Date().toISOString(), 'EX', 8 * 24 * 60 * 60);
    } catch (error) {
      logger.error({ error }, 'Failed to mark weekly email as sent');
    }
  }

  /**
   * Check if at least one therapist is available for booking
   */
  private async isAnyTherapistAvailable(): Promise<boolean> {
    try {
      const available = await this.getAvailableTherapists();
      return available.length > 0;
    } catch (error) {
      logger.error({ error }, 'Failed to check therapist availability');
      return false;
    }
  }

  /**
   * Get all currently available therapists (active and not frozen/booked)
   */
  private async getAvailableTherapists(): Promise<InternalTherapist[]> {
    const therapists = await notionService.fetchTherapists();
    if (therapists.length === 0) return [];

    const unavailableIds = await therapistBookingStatusService.getUnavailableTherapistIds();
    const unavailableSet = new Set(unavailableIds);

    return therapists.filter(t => !unavailableSet.has(t.id));
  }

  /**
   * Determine which therapists are new since the last weekly email.
   * Compares against a Redis-stored set of known IDs but does NOT update it —
   * call recordKnownTherapists() after a successful send so a failing batch
   * doesn't silently mark new therapists as "known".
   */
  private async getNewTherapists(availableTherapists: InternalTherapist[]): Promise<InternalTherapist[]> {
    try {
      const storedJson = await redis.get(WEEKLY_MAILING.KNOWN_THERAPISTS_KEY);
      const knownIdsArray = safeJsonParse<string[]>(storedJson, [], { context: 'known-therapists' });
      const knownIds = new Set(knownIdsArray);
      return availableTherapists.filter(t => !knownIds.has(t.id));
    } catch (error) {
      logger.warn({ error }, 'Failed to determine new therapists, treating all as known');
      return [];
    }
  }

  /**
   * Persist the current available therapist IDs as the new "known" set.
   * Called after a send batch so the next run only flags genuinely new arrivals.
   */
  private async recordKnownTherapists(availableTherapists: InternalTherapist[]): Promise<void> {
    try {
      const currentIds = availableTherapists.map(t => t.id);
      await redis.set(
        WEEKLY_MAILING.KNOWN_THERAPISTS_KEY,
        JSON.stringify(currentIds),
        'EX',
        30 * 24 * 60 * 60,
      );
    } catch (error) {
      logger.warn({ error }, 'Failed to record known therapists set');
    }
  }

  /**
   * Build the "new therapists" section for the weekly email.
   * Returns empty string if no new therapists.
   */
  private buildNewTherapistsSection(newTherapists: InternalTherapist[]): string {
    if (newTherapists.length === 0) return '';

    const therapistLines = newTherapists.map(t => {
      if (t.areasOfFocus.length > 0) {
        return `• ${t.name} — specialises in ${t.areasOfFocus.slice(0, 3).join(', ').toLowerCase()}`;
      }
      return `• ${t.name}`;
    });

    return `\nWe have new therapists available:\n${therapistLines.join('\n')}\n`;
  }

  /**
   * Build the voucher section for the weekly email.
   * For new vouchers: tells user they have a new booking link that expires.
   * For reminders: tells user their existing link expires in X days.
   * Never exposes the voucher code as text — it's only embedded in the booking URL.
   */
  private buildVoucherSection(isReminder: boolean, voucherExpiry: string, daysRemaining?: number): string {
    if (isReminder) {
      const daysText = daysRemaining !== undefined && daysRemaining >= 0
        ? `in ${daysRemaining} day${daysRemaining === 1 ? '' : 's'}`
        : `on ${voucherExpiry}`;
      return `Just a reminder — your personal booking link expires ${daysText}. Don't miss out on your free therapy session.`;
    }
    return `You've been allocated a new personal booking link. It expires on ${voucherExpiry}, so please book before then. Once it's gone, your spot will be offered to someone else.`;
  }

  /**
   * Get users eligible for weekly mailing
   */
  private async getEligibleUsers(): Promise<NotionUser[]> {
    try {
      return await notionUsersService.getEligibleMailingListUsers();
    } catch (error) {
      logger.error({ error }, 'Failed to get eligible mailing list users');
      return [];
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
    };
  }

  /**
   * Send weekly email to a single user.
   *
   * Produces a single unified email with:
   * 1. New therapists section (if any new therapists since last email)
   * 2. Voucher section — either a new code or a reminder about an existing one
   *
   * The voucher code is never shown as text; it is only embedded in the booking URL.
   *
   * Voucher lifecycle (use-it-or-lose-it):
   * - No tracking or expired-and-used: issue new code
   * - Active unused voucher: send reminder for the existing code
   * - Voucher was used: reward with a fresh code (resets strike counter)
   * - After N consecutive expired codes: auto-unsubscribe with final notice
   */
  private async sendWeeklyEmail(
    user: NotionUser,
    emailSettings: EmailSettings,
    newTherapistsSection: string,
  ): Promise<void> {
    const unsubscribeUrl = generateUnsubscribeUrl(user.email, config.backendUrl);

    if (!emailSettings.voucherEnabled) {
      await this.renderAndSend(user, emailSettings, {
        webAppUrl: emailSettings.webAppUrl,
        unsubscribeUrl,
        newTherapistsSection,
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
        newTherapistsSection,
        voucherSection: this.buildVoucherSection(true, formatExpiryDate(expiresAt), daysRemaining),
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
        await this.sendFinalNoticeAndUnsubscribe(user, emailSettings, unsubscribeUrl, tracking, newStrikeCount);
        return;
      }
      tracking = { ...tracking, strikeCount: newStrikeCount };
      logger.info({ email: emailLower, strikeCount: newStrikeCount, maxStrikes }, 'Voucher expired unused, strike incremented');
    } else if (voucherUsed && tracking) {
      tracking = { ...tracking, strikeCount: 0 };
      logger.info({ email: emailLower }, 'Voucher was used, strike count reset');
    }

    await this.sendNewVoucherEmail(user, emailSettings, unsubscribeUrl, newTherapistsSection, tracking);
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
    user: NotionUser,
    emailSettings: EmailSettings,
    unsubscribeUrl: string,
    newTherapistsSection: string,
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
      newTherapistsSection,
      voucherSection: this.buildVoucherSection(false, formatExpiryDate(voucherResult.expiresAt)),
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
    user: NotionUser,
    emailSettings: EmailSettings,
    sections: {
      webAppUrl: string;
      unsubscribeUrl: string;
      newTherapistsSection: string;
      voucherSection: string;
    },
  ): Promise<void> {
    const subject = renderTemplate(emailSettings.subjectTemplate, { userName: user.name });
    const body = renderUnifiedBody(
      emailSettings.bodyTemplate,
      { userName: user.name, webAppUrl: sections.webAppUrl, unsubscribeUrl: sections.unsubscribeUrl },
      sections.newTherapistsSection,
      sections.voucherSection,
    );
    await emailProcessingService.sendEmail({ to: user.email, subject, body });
  }

  /**
   * Send final notice email and auto-unsubscribe the user
   */
  private async sendFinalNoticeAndUnsubscribe(
    user: NotionUser,
    emailSettings: EmailSettings,
    unsubscribeUrl: string,
    tracking: { id: string; strikeCount: number },
    newStrikeCount: number,
  ): Promise<void> {
    const emailLower = user.email.toLowerCase();

    // Send final notice email
    const subject = renderTemplate(emailSettings.finalNoticeSubjectTemplate, { userName: user.name });
    const body = renderTemplate(emailSettings.finalNoticeBodyTemplate, {
      userName: user.name,
      unsubscribeUrl,
    });

    await emailProcessingService.sendEmail({ to: user.email, subject, body });

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

    // Unsubscribe from mailing list in Notion
    if (user.pageId) {
      try {
        await notionUsersService.updateSubscription(user.pageId, false);
        logger.info(
          { email: emailLower, strikeCount: newStrikeCount },
          'Auto-unsubscribed user after consecutive expired vouchers'
        );
      } catch (error) {
        logger.error(
          { error, email: emailLower },
          'Failed to auto-unsubscribe user in Notion (voucher tracking updated)'
        );
      }
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
}

/**
 * Format a date for display in emails (e.g., "2 April 2026")
 */
function formatExpiryDate(date: Date): string {
  return date.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

/**
 * Render the unified weekly email body.
 *
 * The two-pass design avoids double-escaping the system-generated sections:
 * renderTemplate HTML-escapes its variables, but the email body is also passed
 * through convertToHtml downstream which escapes again. So we render user-supplied
 * variables via renderTemplate (escaped once) and inject the section strings
 * via plain replacement (escaped only by convertToHtml).
 */
function renderUnifiedBody(
  template: string,
  variables: TemplateVariables,
  newTherapistsSection: string,
  voucherSection: string,
): string {
  return renderTemplate(template, variables)
    .replace(/\{newTherapistsSection\}/g, newTherapistsSection)
    .replace(/\{voucherSection\}/g, voucherSection);
}

export const weeklyMailingListService = new WeeklyMailingListService();
