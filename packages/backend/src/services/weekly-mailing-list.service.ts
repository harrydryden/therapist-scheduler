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
 * - Distributed lock for multi-instance safety
 * - Tracks last send date to prevent duplicate sends
 * - Includes personalized unsubscribe links
 */

import { config } from '../config';
import { logger } from '../utils/logger';
import { redis } from '../utils/redis';
import { releaseLock, renewLock } from '../utils/redis-locks';
import { notionUsersService, NotionUser } from './notion-users.service';
import { notionService } from './notion.service';
import { therapistBookingStatusService } from './therapist-booking-status.service';
import { emailProcessingService } from './email-processing.service';
import { getSettingValue } from './settings.service';
import { renderTemplate } from '../utils/email-templates';
import { generateUnsubscribeUrl } from '../utils/unsubscribe-token';
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
  private isRunning = false;
  private instanceId: string;
  private lockRenewalId: NodeJS.Timeout | null = null;
  private consecutiveFailures = 0;

  constructor() {
    // Unique instance ID for distributed lock ownership
    this.instanceId = `${process.pid}-${Date.now().toString(36)}-weekly`;
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
    this.stopLockRenewal();
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
   * Attempt to acquire the distributed lock and start renewal atomically.
   * FIX: Previously there was a gap between lock acquisition and renewal start
   * where a crash could leave the lock orphaned. Now renewal starts immediately
   * after acquisition in the same operation.
   */
  private async tryAcquireLockWithRenewal(): Promise<boolean> {
    try {
      const result = await redis.set(
        WEEKLY_MAILING.LOCK_KEY,
        this.instanceId,
        'EX',
        WEEKLY_MAILING.LOCK_TTL_SECONDS,
        'NX'
      );

      if (result === 'OK') {
        // Start renewal immediately - no gap between acquisition and renewal
        this.startLockRenewal();
        return true;
      }
      return false;
    } catch (error) {
      logger.warn({ error }, 'Redis unavailable for weekly mailing lock - using local guard only');
      return true;
    }
  }

  /**
   * Release the lock only if we own it
   */
  private async releaseInstanceLock(): Promise<void> {
    await releaseLock(WEEKLY_MAILING.LOCK_KEY, this.instanceId, 'weekly-mailing');
  }

  /**
   * Start lock renewal
   */
  private startLockRenewal(): void {
    this.lockRenewalId = setInterval(async () => {
      const renewed = await renewLock(WEEKLY_MAILING.LOCK_KEY, this.instanceId, WEEKLY_MAILING.LOCK_TTL_SECONDS);
      if (!renewed) {
        logger.warn('Weekly mailing lock lost - another instance may have taken over');
      }
    }, WEEKLY_MAILING.RENEWAL_INTERVAL_MS);
  }

  /**
   * Stop lock renewal
   */
  private stopLockRenewal(): void {
    if (this.lockRenewalId) {
      clearInterval(this.lockRenewalId);
      this.lockRenewalId = null;
    }
  }

  /**
   * Safe wrapper that catches errors without crashing the interval
   */
  private async runSafeCheck(): Promise<void> {
    // Local guard to prevent overlapping checks
    if (this.isRunning) {
      logger.debug('Weekly mailing check already running, skipping');
      return;
    }

    this.isRunning = true;

    // Try to acquire distributed lock (starts renewal atomically)
    const lockAcquired = await this.tryAcquireLockWithRenewal();
    if (!lockAcquired) {
      logger.debug('Another instance is handling weekly mailing, skipping');
      this.isRunning = false;
      return;
    }

    try {
      await this.checkAndSendWeeklyEmail();
      // FIX L2: Reset failure counter on success
      this.consecutiveFailures = 0;
    } catch (error) {
      // FIX L2: Implement retry with exponential backoff
      this.consecutiveFailures++;
      const shouldRetry = this.consecutiveFailures <= RETRY_CONFIG.MAX_RETRIES;
      const backoffDelay = Math.min(
        RETRY_CONFIG.BASE_DELAY_MS * Math.pow(2, this.consecutiveFailures - 1),
        RETRY_CONFIG.MAX_DELAY_MS
      );

      logger.error(
        { error, consecutiveFailures: this.consecutiveFailures, willRetry: shouldRetry, backoffMs: backoffDelay },
        'Error in weekly mailing check'
      );

      if (shouldRetry) {
        // Schedule a retry after backoff delay
        setTimeout(() => {
          logger.info({ attempt: this.consecutiveFailures + 1 }, 'Retrying weekly mailing check');
          this.runSafeCheck();
        }, backoffDelay);
      }
    } finally {
      this.stopLockRenewal();
      await this.releaseInstanceLock();
      this.isRunning = false;
    }
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

    // Send emails
    let sent = 0;
    let failed = 0;

    for (const user of users) {
      try {
        await this.sendWeeklyEmail(user);
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
   * Main check function - determines if it's time to send and processes eligible users
   */
  private async checkAndSendWeeklyEmail(): Promise<void> {
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

    // Send emails
    let sent = 0;
    let failed = 0;

    for (const user of users) {
      try {
        await this.sendWeeklyEmail(user);
        sent++;
      } catch (error) {
        logger.error({ error, email: user.email }, 'Failed to send weekly email to user');
        failed++;
      }
    }

    // Mark as sent for this week
    await this.markAsSent();

    logger.info({ checkId, sent, failed, total: users.length }, 'Weekly mailing complete');
  }

  /**
   * Check if current time matches the configured send day and hour
   */
  private async shouldSendNow(): Promise<boolean> {
    const sendDay = await getSettingValue<number>('weeklyMailing.sendDay');
    const sendHour = await getSettingValue<number>('weeklyMailing.sendHour');
    const timezone = await getSettingValue<string>('general.timezone');

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
   * Send weekly email to a single user
   */
  private async sendWeeklyEmail(user: NotionUser): Promise<void> {
    // Get templates and settings
    const subjectTemplate = await getSettingValue<string>('email.weeklyMailingSubject');
    const bodyTemplate = await getSettingValue<string>('email.weeklyMailingBody');
    const webAppUrl = await getSettingValue<string>('weeklyMailing.webAppUrl');

    // Generate unsubscribe URL using configured backend URL
    const unsubscribeUrl = generateUnsubscribeUrl(user.email, config.backendUrl);

    // Render templates
    const subject = renderTemplate(subjectTemplate, { userName: user.name });
    const body = renderTemplate(bodyTemplate, {
      userName: user.name,
      webAppUrl,
      unsubscribeUrl,
    });

    // Send email using the emailProcessingService
    await emailProcessingService.sendEmail({
      to: user.email,
      subject,
      body,
    });

    logger.info({ email: user.email }, 'Sent weekly mailing email');
  }
}

export const weeklyMailingListService = new WeeklyMailingListService();
