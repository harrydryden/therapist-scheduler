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
import { notionService } from './notion.service';
import { therapistBookingStatusService } from './therapist-booking-status.service';
import { emailProcessingService } from './email-processing.service';
import { getSettingValue, getSettingValues } from './settings.service';
import { renderTemplate } from '../utils/email-templates';
import { generateUnsubscribeUrl } from '../utils/unsubscribe-token';
import { generateVoucherToken, generateVoucherUrl, getDisplayCodeFromToken } from '../utils/voucher-token';
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

    // Get eligible users
    const users = await this.getEligibleUsers();
    if (users.length === 0) {
      logger.info({ checkId }, 'No eligible users for weekly mailing');
      return { sent: 0, failed: 0, total: 0 };
    }

    logger.info({ checkId, userCount: users.length }, 'Force sending weekly emails');

    // Fetch email template settings once for the entire batch
    const emailSettings = await this.fetchEmailSettings();

    // Send emails
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

    // Mark as sent for this week
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

    // Check if any therapist is available
    if (!(await this.isAnyTherapistAvailable())) {
      logger.info({ checkId }, 'No therapists available - skipping weekly mailing');
      return;
    }

    // Get eligible users
    const users = await this.getEligibleUsers();
    if (users.length === 0) {
      logger.info({ checkId }, 'No eligible users for weekly mailing');
      // Still mark as sent to avoid rechecking every hour
      await this.markAsSent();
      return;
    }

    logger.info({ checkId, userCount: users.length }, 'Sending weekly emails');

    // Fetch email template settings once for the entire batch
    const emailSettings = await this.fetchEmailSettings();

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
        await this.sendWeeklyEmail(user, emailSettings);
        sent++;
      } catch (error) {
        logger.error({ error, email: user.email }, 'Failed to send weekly email to user');
        failed++;
      }
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
      // Get all active therapists
      const therapists = await notionService.fetchTherapists();
      if (therapists.length === 0) return false;

      // Get unavailable therapist IDs (frozen/booked)
      const unavailableIds = await therapistBookingStatusService.getUnavailableTherapistIds();
      const unavailableSet = new Set(unavailableIds);

      // Check if any therapist is available
      return therapists.some(t => !unavailableSet.has(t.id));
    } catch (error) {
      logger.error({ error }, 'Failed to check therapist availability');
      return false;
    }
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
      'email.voucherReminderSubject',
      'email.voucherReminderBody',
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
      reminderSubjectTemplate: settingsMap.get('email.voucherReminderSubject') as string,
      reminderBodyTemplate: settingsMap.get('email.voucherReminderBody') as string,
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
   * When vouchers are enabled, implements the use-it-or-lose-it lifecycle:
   * - If no active voucher (or used/expired): issue a new code
   * - If active voucher still valid and unused: send reminder
   * - If voucher was used: reward with a fresh code immediately
   * - After N consecutive expired codes: auto-unsubscribe and send final notice
   */
  private async sendWeeklyEmail(
    user: NotionUser,
    emailSettings: EmailSettings,
  ): Promise<void> {
    const { webAppUrl } = emailSettings;

    // Generate unsubscribe URL using configured backend URL
    const unsubscribeUrl = generateUnsubscribeUrl(user.email, config.backendUrl);

    if (!emailSettings.voucherEnabled) {
      // Original non-voucher flow
      const subject = renderTemplate(emailSettings.subjectTemplate, { userName: user.name });
      const body = renderTemplate(emailSettings.bodyTemplate, {
        userName: user.name,
        webAppUrl,
        unsubscribeUrl,
      });

      await emailProcessingService.sendEmail({ to: user.email, subject, body });
      logger.info({ email: user.email }, 'Sent weekly mailing email (no voucher)');
      return;
    }

    // === Voucher-enabled flow ===
    const emailLower = user.email.toLowerCase();
    const expiryDays = emailSettings.voucherExpiryDays;
    const maxStrikes = emailSettings.voucherMaxStrikes;

    // Get or create voucher tracking record
    let tracking = await prisma.voucherTracking.findUnique({ where: { id: emailLower } });

    // Determine voucher state
    const now = new Date();
    const hasActiveVoucher = tracking?.lastVoucherSentAt &&
      (now.getTime() - tracking.lastVoucherSentAt.getTime()) < expiryDays * 24 * 60 * 60 * 1000;
    const voucherUsed = tracking?.lastVoucherUsedAt && tracking?.lastVoucherSentAt &&
      tracking.lastVoucherUsedAt > tracking.lastVoucherSentAt;

    if (hasActiveVoucher && !voucherUsed) {
      // Active voucher, not yet used → send REMINDER email
      const existingToken = tracking!.lastVoucherToken;
      if (!existingToken) {
        logger.warn({ email: emailLower }, 'Voucher tracking has no stored token, issuing new one');
        await this.sendNewVoucherEmail(user, emailSettings, unsubscribeUrl, tracking);
        return;
      }

      const displayCode = getDisplayCodeFromToken(existingToken) || 'your code';
      const expiresAt = new Date(tracking!.lastVoucherSentAt!.getTime() + expiryDays * 24 * 60 * 60 * 1000);
      const voucherExpiry = formatExpiryDate(expiresAt);

      // Build reminder URL with existing token
      const separator = webAppUrl.includes('?') ? '&' : '?';
      const voucherWebAppUrl = `${webAppUrl}${separator}voucher=${encodeURIComponent(existingToken)}`;

      const subject = renderTemplate(emailSettings.reminderSubjectTemplate, {
        userName: user.name,
        voucherCode: displayCode,
      });
      const body = renderTemplate(emailSettings.reminderBodyTemplate, {
        userName: user.name,
        voucherCode: displayCode,
        voucherExpiry,
        webAppUrl: voucherWebAppUrl,
        unsubscribeUrl,
      });

      await emailProcessingService.sendEmail({ to: user.email, subject, body });

      // Update tracking
      await prisma.voucherTracking.update({
        where: { id: emailLower },
        data: { reminderSentAt: now },
      });

      logger.info({ email: emailLower, displayCode }, 'Sent voucher reminder email');
      return;
    }

    // Either no active voucher, voucher expired, or voucher was used → issue new code
    // First check if the previous voucher expired unused (strike)
    if (tracking?.lastVoucherSentAt && !voucherUsed && !hasActiveVoucher) {
      // Previous voucher expired without being used → increment strike
      const newStrikeCount = (tracking.strikeCount || 0) + 1;

      if (newStrikeCount >= maxStrikes) {
        // Auto-unsubscribe: send final notice and stop
        await this.sendFinalNoticeAndUnsubscribe(user, emailSettings, unsubscribeUrl, tracking, newStrikeCount);
        return;
      }

      // Update strike count
      await prisma.voucherTracking.update({
        where: { id: emailLower },
        data: { strikeCount: newStrikeCount },
      });

      tracking = { ...tracking, strikeCount: newStrikeCount };
      logger.info(
        { email: emailLower, strikeCount: newStrikeCount, maxStrikes },
        'Voucher expired unused, strike incremented'
      );
    }

    // If voucher was used → reset strikes (reward)
    if (voucherUsed && tracking) {
      await prisma.voucherTracking.update({
        where: { id: emailLower },
        data: { strikeCount: 0 },
      });
      tracking = { ...tracking, strikeCount: 0 };
      logger.info({ email: emailLower }, 'Voucher was used, strike count reset');
    }

    // Issue new voucher
    await this.sendNewVoucherEmail(user, emailSettings, unsubscribeUrl, tracking);
  }

  /**
   * Generate and send a new voucher code email
   */
  private async sendNewVoucherEmail(
    user: NotionUser,
    emailSettings: EmailSettings,
    unsubscribeUrl: string,
    tracking: { id: string; strikeCount: number } | null,
  ): Promise<void> {
    const emailLower = user.email.toLowerCase();
    const expiryDays = emailSettings.voucherExpiryDays;
    const { webAppUrl } = emailSettings;

    // Generate new voucher
    const voucherResult = generateVoucherUrl(emailLower, webAppUrl, expiryDays);
    const voucherExpiry = formatExpiryDate(voucherResult.expiresAt);

    const subject = renderTemplate(emailSettings.subjectTemplate, {
      userName: user.name,
      voucherCode: voucherResult.displayCode,
    });
    const body = renderTemplate(emailSettings.bodyTemplate, {
      userName: user.name,
      voucherCode: voucherResult.displayCode,
      voucherExpiry,
      webAppUrl: voucherResult.url,
      unsubscribeUrl,
    });

    await emailProcessingService.sendEmail({ to: user.email, subject, body });

    // Upsert tracking record
    const now = new Date();
    await prisma.voucherTracking.upsert({
      where: { id: emailLower },
      create: {
        id: emailLower,
        lastVoucherSentAt: now,
        lastVoucherToken: voucherResult.token,
        strikeCount: 0,
        reminderSentAt: null,
      },
      update: {
        lastVoucherSentAt: now,
        lastVoucherToken: voucherResult.token,
        reminderSentAt: null,
      },
    });

    logger.info(
      { email: emailLower, displayCode: voucherResult.displayCode, expiresAt: voucherResult.expiresAt.toISOString() },
      'Sent new voucher email'
    );
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
  reminderSubjectTemplate: string;
  reminderBodyTemplate: string;
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

export const weeklyMailingListService = new WeeklyMailingListService();
