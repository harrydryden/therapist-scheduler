/**
 * Post-Booking Follow-up Service
 *
 * Handles automated follow-up emails after appointments are confirmed:
 * 1. Meeting Link Check - 24h after confirmation (or 4h before appointment if sooner)
 * 2. Feedback Form - 1h after session ends (sent to user only)
 *
 * Runs as a background service checking every 15 minutes.
 *
 * Reliability features:
 * - Marks emails as "sending" before attempting to prevent duplicates
 * - Uses batch processing with configurable limits
 * - Tracks parse failures to avoid log spam
 * - Handles cancelled appointments correctly
 */

import { prisma } from '../utils/database';
import { logger } from '../utils/logger';
import {
  tryClaimSentinel,
  confirmSentinelClaim,
  releaseSentinelClaim,
} from '../utils/atomic-sentinel-claim';
import { PeriodicService } from '../utils/periodic-service';
import { emailProcessingService } from './email-processing.service';
import { appointmentLifecycleService } from './appointment-lifecycle.service';
import {
  parseConfirmedDateTime,
  calculateMeetingLinkCheckTime,
  calculateFeedbackFormTime,
  isInPast,
  formatEmailDateFromSettings,
} from '../utils/date';
import { getEmailSubject, getEmailBody } from '../utils/email-templates';
import { firstName } from '../utils/first-name';
import { getSettingValue } from './settings.service';
import { resolveRecipientTimezone } from './recipient-timezone.service';
import { auditEventService } from './audit-event.service';
import { POST_BOOKING, APPOINTMENT_STATUS, POST_BOOKING_PROCESSING } from '../constants';
import { generateFeedbackToken } from '../utils/feedback-token';

// Processing constants — imported from centralized constants
const {
  BATCH_SIZE,
  MAX_PARSE_ATTEMPTS,
  PARSE_FAILURE_RESET_MS,
  DAILY_REPARSE_MS,
} = POST_BOOKING_PROCESSING;

interface ParseFailureEntry {
  count: number;
  lastAttempt: number;
  firstFailure: number; // Track when we first started failing to enable daily reparse
}

class PostBookingFollowupService extends PeriodicService {
  // Track parse failures with timestamps to allow retry after reset period
  // Bounded to prevent unbounded memory growth
  private static MAX_PARSE_FAILURES = POST_BOOKING_PROCESSING.MAX_PARSE_FAILURES;
  private parseFailures: Map<string, ParseFailureEntry> = new Map();

  constructor() {
    super({
      name: 'post-booking-followup',
      intervalMs: POST_BOOKING.CHECK_INTERVAL_MS,
    });
  }

  /**
   * Get service status for health checks
   */
  getStatus(): { running: boolean; intervalMs: number; parseFailures: number } {
    return {
      ...super.getStatus(),
      parseFailures: this.parseFailures.size,
    };
  }

  protected async runCheck(): Promise<void> {
    await this.processFollowUps();
  }

  /**
   * Main processing loop - handles meeting link checks, feedback forms, and session reminders
   */
  private async processFollowUps(): Promise<void> {
    const checkId = Date.now().toString(36);
    logger.info({ checkId }, 'Running post-booking follow-up check');

    try {
      // First, cleanup any stuck sentinel values (from crashed processes)
      await this.cleanupStuckSentinels(checkId);

      // Ensure all confirmed appointments have parsed datetime
      await this.parseUnparsedDateTimes(checkId);

      // Process session reminders (24h before appointment) - Edge Case #6
      await this.processSessionReminders(checkId);

      // Process meeting link checks
      await this.processMeetingLinkChecks(checkId);

      // Process feedback forms
      await this.processFeedbackForms(checkId);

      // Process feedback reminders (chaser if no feedback received)
      await this.processFeedbackReminders(checkId);
    } catch (error) {
      logger.error({ checkId, error }, 'Failed to run post-booking follow-up check');
    }
  }

  /**
   * Reset any stuck sentinel values (epoch date = sending) that have been stuck for >2 minutes
   * This handles edge cases where a process crashed mid-send
   *
   * Reduced from 5 minutes to 2 minutes to minimize window of missed follow-ups
   * during frequent process restarts (e.g., deployments)
   */
  private async cleanupStuckSentinels(checkId: string): Promise<void> {
    const epochDate = new Date(0);
    const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000);

    // All 4 sentinel resets are independent — run concurrently
    const sentinelFields = [
      { field: 'meetingLinkCheckSentAt', label: 'meeting link check' },
      { field: 'feedbackFormSentAt', label: 'feedback form' },
      { field: 'reminderSentAt', label: 'session reminder' },
      { field: 'feedbackReminderSentAt', label: 'feedback reminder' },
    ] as const;

    const results = await Promise.all(
      sentinelFields.map(({ field }) =>
        prisma.appointmentRequest.updateMany({
          where: { [field]: epochDate, updatedAt: { lt: twoMinutesAgo } },
          data: { [field]: null },
        })
      )
    );

    for (let i = 0; i < results.length; i++) {
      if (results[i].count > 0) {
        logger.warn(
          { checkId, resetCount: results[i].count },
          `Reset stuck ${sentinelFields[i].label} sentinels`
        );
      }
    }
  }

  /**
   * Parse and store confirmedDateTimeParsed for appointments that don't have it
   * Includes backoff for repeated failures to avoid log spam
   */
  private async parseUnparsedDateTimes(checkId: string): Promise<void> {
    const unparsed = await prisma.appointmentRequest.findMany({
      where: {
        status: APPOINTMENT_STATUS.CONFIRMED,
        confirmedDateTime: { not: null },
        confirmedDateTimeParsed: null,
      },
      select: {
        id: true,
        confirmedDateTime: true,
        confirmedAt: true,
      },
      take: BATCH_SIZE, // Limit batch size
    });

    if (unparsed.length === 0) return;

    logger.info({ checkId, count: unparsed.length }, 'Parsing confirmed datetimes');

    let parsed = 0;
    let skipped = 0;

    const now = Date.now();

    for (const appointment of unparsed) {
      if (!appointment.confirmedDateTime) continue;

      // Check if we've already failed to parse this too many times
      const failure = this.parseFailures.get(appointment.id);
      if (failure) {
        // Reset if enough time has passed since last attempt (allows retry if confirmedDateTime was updated)
        // OR if 24 hours have passed since first failure (daily reparse attempt)
        const timeSinceLastAttempt = now - failure.lastAttempt;
        const timeSinceFirstFailure = now - failure.firstFailure;

        if (timeSinceLastAttempt > PARSE_FAILURE_RESET_MS) {
          this.parseFailures.delete(appointment.id);
          logger.debug(
            { checkId, appointmentId: appointment.id },
            'Retrying datetime parse after 1h backoff'
          );
        } else if (timeSinceFirstFailure > DAILY_REPARSE_MS) {
          // Daily retry - reset and try again
          this.parseFailures.delete(appointment.id);
          logger.info(
            { checkId, appointmentId: appointment.id, hoursSinceFirstFailure: Math.round(timeSinceFirstFailure / (60 * 60 * 1000)) },
            'Attempting daily reparse of previously failed datetime'
          );
        } else if (failure.count >= MAX_PARSE_ATTEMPTS) {
          skipped++;
          continue; // Skip - already logged warning, avoid spam
        }
      }

      // Use confirmedAt as reference date for parsing (more accurate for relative dates)
      const referenceDate = appointment.confirmedAt || new Date();
      const parsedDate = parseConfirmedDateTime(appointment.confirmedDateTime, referenceDate);

      if (parsedDate) {
        try {
          await prisma.appointmentRequest.update({
            where: { id: appointment.id },
            data: { confirmedDateTimeParsed: parsedDate },
            select: { id: true },
          });
          // Clear any previous failure count on success
          this.parseFailures.delete(appointment.id);
          parsed++;
          logger.debug(
            { checkId, appointmentId: appointment.id, original: appointment.confirmedDateTime, parsed: parsedDate.toISOString() },
            'Parsed and stored confirmed datetime'
          );
        } catch (updateError) {
          // Database update failed - log but don't crash the loop
          logger.error(
            { checkId, appointmentId: appointment.id, error: updateError },
            'Failed to store parsed datetime - will retry next cycle'
          );
          // Don't clear parse failure tracking since we didn't actually succeed
        }
      } else {
        // Increment failure count with timestamp
        const currentEntry = this.parseFailures.get(appointment.id);
        const newCount = (currentEntry?.count || 0) + 1;
        this.parseFailures.set(appointment.id, {
          count: newCount,
          lastAttempt: now,
          firstFailure: currentEntry?.firstFailure || now, // Keep original first failure time
        });

        // Evict oldest entries if map exceeds bounds
        if (this.parseFailures.size > PostBookingFollowupService.MAX_PARSE_FAILURES) {
          let oldestKey: string | null = null;
          let oldestTime = Infinity;
          for (const [key, entry] of this.parseFailures) {
            if (entry.lastAttempt < oldestTime) {
              oldestTime = entry.lastAttempt;
              oldestKey = key;
            }
          }
          if (oldestKey) this.parseFailures.delete(oldestKey);
        }

        // Only log on first failure or when reaching max attempts
        if (newCount === 1) {
          logger.warn(
            { checkId, appointmentId: appointment.id, confirmedDateTime: appointment.confirmedDateTime },
            'Failed to parse confirmed datetime - will retry'
          );
        } else if (newCount === MAX_PARSE_ATTEMPTS) {
          logger.error(
            { checkId, appointmentId: appointment.id, confirmedDateTime: appointment.confirmedDateTime, attempts: newCount },
            'Failed to parse confirmed datetime after max attempts - will retry in 1 hour'
          );
        }
      }
    }

    if (parsed > 0 || skipped > 0) {
      logger.info({ checkId, parsed, skipped }, 'Datetime parsing complete');
    }
  }

  /**
   * Send session reminder emails (Edge Case #6)
   *
   * Rules:
   * - Send X hours before the appointment start time (configurable, default 4h)
   * - Send to BOTH user AND therapist
   * - Skip if appointment already passed
   * - Skip if already sent or sending
   * - Skip if appointment is cancelled
   *
   * Uses optimistic locking pattern to prevent duplicates
   */
  private async processSessionReminders(checkId: string): Promise<void> {
    const now = new Date();

    // Get configurable reminder window (default 4 hours before session)
    const reminderHoursBefore = await getSettingValue<number>('postBooking.sessionReminderHoursBefore');
    const reminderWindowMs = reminderHoursBefore * 60 * 60 * 1000;
    const reminderWindowEnd = new Date(now.getTime() + reminderWindowMs);

    // Find confirmed appointments that:
    // - Have a parsed datetime within the reminder window
    // - Haven't had reminder sent
    // - Status is still confirmed (not cancelled)
    const candidates = await prisma.appointmentRequest.findMany({
      where: {
        status: APPOINTMENT_STATUS.CONFIRMED,
        confirmedDateTimeParsed: {
          not: null,
          gt: now, // Future appointments only
          lte: reminderWindowEnd, // Within reminder window
        },
        reminderSentAt: null,
      },
      select: {
        id: true,
        userName: true,
        userEmail: true,
        therapistName: true,
        therapistEmail: true,
        confirmedDateTime: true,
        confirmedDateTimeParsed: true,
        gmailThreadId: true,
        therapistGmailThreadId: true,
        status: true,
        notes: true,
      },
      take: BATCH_SIZE,
      orderBy: { confirmedDateTimeParsed: 'asc' }, // Process soonest appointments first
    });

    if (candidates.length === 0) return;

    let sent = 0;
    let skipped = 0;

    for (const appointment of candidates) {
      if (!appointment.confirmedDateTimeParsed) continue;

      // Double-check status hasn't changed to cancelled
      if (appointment.status !== APPOINTMENT_STATUS.CONFIRMED) {
        skipped++;
        continue;
      }

      // Double-check appointment hasn't passed
      if (isInPast(appointment.confirmedDateTimeParsed)) {
        logger.debug(
          { checkId, appointmentId: appointment.id },
          'Skipping session reminder - appointment already passed'
        );
        skipped++;
        continue;
      }

      // OPTIMISTIC LOCKING: claim via the shared sentinel helper. The
      // status precondition aborts the claim if the appointment drifted
      // out of `confirmed` between the candidate query and the claim.
      if (!(await tryClaimSentinel(appointment.id, 'reminderSentAt', {
        extraWhere: { status: APPOINTMENT_STATUS.CONFIRMED },
      }))) {
        logger.debug(
          { checkId, appointmentId: appointment.id },
          'Session reminder already being processed or appointment status changed'
        );
        continue;
      }

      try {
        // Track which emails succeeded to prevent duplicate sends on partial failure
        let userSent = false;
        let therapistSent = false;

        // Send reminder to user
        try {
          await this.sendSessionReminderEmail(appointment, 'user');
          userSent = true;
        } catch (userError) {
          logger.error(
            { checkId, appointmentId: appointment.id, error: userError },
            'Failed to send session reminder to user'
          );
        }

        // Send reminder to therapist
        try {
          await this.sendSessionReminderEmail(appointment, 'therapist');
          therapistSent = true;
        } catch (therapistError) {
          logger.error(
            { checkId, appointmentId: appointment.id, error: therapistError },
            'Failed to send session reminder to therapist'
          );
        }

        // FIX #16: Handle partial vs full success differently
        if (userSent && therapistSent) {
          // Full success - mark as complete
          const confirmed = await confirmSentinelClaim(appointment.id, 'reminderSentAt', now);

          if (!confirmed) {
            logger.error(
              { checkId, appointmentId: appointment.id },
              'ALERT: Session reminder emails sent but sentinel update failed - possible duplicate'
            );
            try {
              await prisma.appointmentRequest.update({
                where: { id: appointment.id },
                data: {
                  notes: `${appointment.notes || ''}\n[SYSTEM ALERT ${new Date().toISOString()}]: sessionReminder emails sent but tracking update failed - review for duplicates`,
                },
                select: { id: true },
              });
            } catch {
              // Ignore - already logged main issue
            }
          }

          sent++;
          logger.info(
            { checkId, appointmentId: appointment.id, userEmail: appointment.userEmail, therapistEmail: appointment.therapistEmail },
            'Sent session reminder emails to user and therapist'
          );
        } else if (userSent || therapistSent) {
          // Partial success - set sentinel to prevent re-sending to successful recipient,
          // but flag as stale for admin attention
          const failedRecipient = !userSent ? 'user' : 'therapist';
          const succeededRecipient = userSent ? 'user' : 'therapist';

          // Partial-success confirm: set the real timestamp AND
          // raise isStale atomically with the sentinel flip.
          const confirmed = await confirmSentinelClaim(appointment.id, 'reminderSentAt', now, {
            extraData: { isStale: true },
          });

          if (confirmed) {
            try {
              await prisma.appointmentRequest.update({
                where: { id: appointment.id },
                data: {
                  notes: `${appointment.notes || ''}\n[SYSTEM ALERT ${new Date().toISOString()}]: Session reminder sent to ${succeededRecipient} but FAILED for ${failedRecipient} - manual follow-up required`,
                },
                select: { id: true },
              });
            } catch {
              // Ignore - already logged main issue
            }
          }

          logger.warn(
            { checkId, appointmentId: appointment.id, userSent, therapistSent, failedRecipient },
            'Partial session reminder send - flagged as stale for admin follow-up'
          );
        } else {
          // Both failed - reset to retry
          await prisma.appointmentRequest.update({
            where: { id: appointment.id },
            data: { reminderSentAt: null },
            select: { id: true },
          });
          logger.error(
            { checkId, appointmentId: appointment.id },
            'Failed to send both session reminder emails - will retry next cycle'
          );
        }
      } catch (error) {
        // Unexpected error - reset to null so it can be retried
        await prisma.appointmentRequest.update({
          where: { id: appointment.id },
          data: { reminderSentAt: null },
          select: { id: true },
        });

        logger.error(
          { checkId, appointmentId: appointment.id, error },
          'Unexpected error in session reminder processing - will retry next cycle'
        );
      }
    }

    if (sent > 0 || skipped > 0) {
      logger.info({ checkId, sent, skipped, checked: candidates.length }, 'Session reminder processing complete');
    }
  }

  /**
   * Send meeting link check emails
   *
   * Rules:
   * - Send 24 hours after confirmation
   * - UNLESS that would be after appointment time → send 4 hours before instead
   * - Skip if appointment already passed
   * - Skip if already sent or sending
   * - Skip if appointment is cancelled
   *
   * Uses optimistic locking pattern: mark as "sending" first, then send, then mark "sent"
   */
  private async processMeetingLinkChecks(checkId: string): Promise<void> {
    const now = new Date();

    // Fetched once per tick so the inner loop doesn't hit settings per-appointment.
    // Used below to skip the meeting-link check when the session-reminder window
    // is already open — in that case the reminder is the better channel for "your
    // session is approaching" and we don't want both emails landing within minutes.
    const sessionReminderHoursBefore = await getSettingValue<number>('postBooking.sessionReminderHoursBefore');
    const sessionReminderWindowMs = sessionReminderHoursBefore * 60 * 60 * 1000;

    // Find confirmed appointments that:
    // - Have a parsed datetime
    // - Haven't had meeting link check sent
    // - Appointment hasn't passed yet
    // - Status is still confirmed (not cancelled)
    const candidates = await prisma.appointmentRequest.findMany({
      where: {
        status: APPOINTMENT_STATUS.CONFIRMED,
        confirmedDateTimeParsed: { not: null, gt: now }, // Future appointments only
        meetingLinkCheckSentAt: null,
        confirmedAt: { not: null },
      },
      select: {
        id: true,
        userName: true,
        userEmail: true,
        therapistName: true,
        confirmedDateTime: true,
        confirmedDateTimeParsed: true,
        confirmedAt: true,
        gmailThreadId: true,
        status: true, // Include status for double-check
        notes: true, // FIX B5: Include notes for error logging
      },
      take: BATCH_SIZE, // Limit batch size
      orderBy: { confirmedDateTimeParsed: 'asc' }, // Process soonest appointments first
    });

    if (candidates.length === 0) return;

    let sent = 0;
    let skipped = 0;

    for (const appointment of candidates) {
      if (!appointment.confirmedAt || !appointment.confirmedDateTimeParsed) continue;

      // Double-check status hasn't changed to cancelled
      if (appointment.status !== APPOINTMENT_STATUS.CONFIRMED) {
        skipped++;
        continue;
      }

      const sendTime = calculateMeetingLinkCheckTime(
        appointment.confirmedAt,
        appointment.confirmedDateTimeParsed
      );

      // Is it time to send?
      if (sendTime > now) {
        continue; // Not yet due, no need to log each one
      }

      // Double-check appointment hasn't passed (edge case with clock skew)
      if (isInPast(appointment.confirmedDateTimeParsed)) {
        logger.debug(
          { checkId, appointmentId: appointment.id },
          'Skipping meeting link check - appointment already passed'
        );
        skipped++;
        continue;
      }

      // Defer to the session reminder when we're already inside its window.
      // Short-notice bookings (confirmed <4h before the slot) would otherwise
      // produce both the meeting-link nudge and the session reminder within
      // the same 15-minute tick. The reminder covers the "session is soon"
      // beat for the user; the meeting-link nudge is the wrong tool when the
      // session is imminent anyway. The candidate filter
      // (`confirmedDateTimeParsed > now`) ages this appointment out naturally
      // once the slot passes, so leaving the sentinel as null is fine.
      if (appointment.confirmedDateTimeParsed.getTime() - now.getTime() <= sessionReminderWindowMs) {
        logger.debug(
          { checkId, appointmentId: appointment.id },
          'Skipping meeting link check — session reminder window already open',
        );
        skipped++;
        continue;
      }

      // OPTIMISTIC LOCKING: Try to mark as "sending" first
      // This prevents duplicates if another instance or the same instance processes this
      if (!(await tryClaimSentinel(appointment.id, 'meetingLinkCheckSentAt', {
        extraWhere: { status: APPOINTMENT_STATUS.CONFIRMED },
      }))) {
        logger.debug(
          { checkId, appointmentId: appointment.id },
          'Meeting link check already being processed or appointment status changed'
        );
        continue;
      }

      try {
        await this.sendMeetingLinkCheckEmail(appointment);

        // Log follow_up_sent audit event
        auditEventService.log(appointment.id, 'follow_up_sent', 'system', {
          followUpType: 'meeting_link_check',
        });

        // FIX B5: Use atomic update with sentinel check to verify we still own the lock
        // This prevents race condition where update fails silently after email sent
        const confirmed = await confirmSentinelClaim(appointment.id, 'meetingLinkCheckSentAt', now);

        // FIX B5: Verify update succeeded
        if (!confirmed) {
          // This should never happen - sentinel was taken by another process
          // or something went wrong. Email was already sent though.
          logger.error(
            { checkId, appointmentId: appointment.id },
            'ALERT: Meeting link check email sent but sentinel update failed - possible duplicate'
          );
          // Try to add a note for admin review
          try {
            await prisma.appointmentRequest.update({
              where: { id: appointment.id },
              data: {
                notes: `${appointment.notes || ''}\n[SYSTEM ALERT ${new Date().toISOString()}]: meetingLinkCheck email sent but tracking update failed - review for duplicates`,
              },
              select: { id: true },
            });
          } catch {
            // Ignore error - already logged the main issue
          }
        } else {
          sent++;
          logger.info(
            { checkId, appointmentId: appointment.id, userEmail: appointment.userEmail },
            'Sent meeting link check email'
          );
        }
      } catch (error) {
        // On failure, reset to null so it can be retried
        await prisma.appointmentRequest.update({
          where: { id: appointment.id },
          data: { meetingLinkCheckSentAt: null },
          select: { id: true },
        });

        logger.error(
          { checkId, appointmentId: appointment.id, error },
          'Failed to send meeting link check email - will retry next cycle'
        );
      }
    }

    if (sent > 0 || skipped > 0) {
      logger.info({ checkId, sent, skipped, checked: candidates.length }, 'Meeting link check processing complete');
    }
  }

  /**
   * Send feedback form emails
   *
   * Rules:
   * - Send 1 hour after session start time (50min session + 10min buffer)
   * - Send to USER only (not therapist)
   * - Skip if already sent or sending
   * - Skip if appointment is cancelled
   * - Look for session_held status only (FIX #11: confirmed removed to prevent skipping session_held)
   * - Transition to feedback_requested after sending
   *
   * Uses optimistic locking pattern to prevent duplicates
   */
  private async processFeedbackForms(checkId: string): Promise<void> {
    const now = new Date();

    // Find appointments that:
    // - Have a parsed datetime
    // - Haven't had feedback form sent
    // - Status is session_held (FIX #11: require session_held only to prevent skipping this status)
    const candidates = await prisma.appointmentRequest.findMany({
      where: {
        status: APPOINTMENT_STATUS.SESSION_HELD,
        confirmedDateTimeParsed: { not: null },
        feedbackFormSentAt: null,
      },
      select: {
        id: true,
        userName: true,
        userEmail: true,
        therapistName: true,
        therapistEmail: true,
        confirmedDateTime: true,
        confirmedDateTimeParsed: true,
        gmailThreadId: true,
        therapistGmailThreadId: true,
        trackingCode: true, // Include for native feedback form URL
        status: true, // Include status for double-check
        notes: true, // FIX B5: Include notes for error logging
      },
      take: BATCH_SIZE, // Limit batch size
      orderBy: { confirmedDateTimeParsed: 'asc' }, // Process oldest appointments first
    });

    if (candidates.length === 0) return;

    let sent = 0;
    let skipped = 0;

    for (const appointment of candidates) {
      if (!appointment.confirmedDateTimeParsed) continue;

      // Double-check status is session_held (FIX #11)
      if (appointment.status !== APPOINTMENT_STATUS.SESSION_HELD) {
        skipped++;
        continue;
      }

      const feedbackTime = calculateFeedbackFormTime(appointment.confirmedDateTimeParsed);

      // Is it time to send?
      if (feedbackTime > now) {
        continue; // Not yet due
      }

      // OPTIMISTIC LOCKING: claim via the shared sentinel helper. The
      // status precondition (FIX #11) restricts the claim to rows still
      // in `session_held`.
      const claimed = await tryClaimSentinel(appointment.id, 'feedbackFormSentAt', {
        extraWhere: { status: APPOINTMENT_STATUS.SESSION_HELD },
      });

      // If no rows updated, another process got there first or status changed
      if (!claimed) {
        logger.debug(
          { checkId, appointmentId: appointment.id },
          'Feedback form already being processed or appointment status changed'
        );
        continue;
      }

      try {
        // FIX #23: If trackingCode is null, skip the email send to avoid infinite retry loop.
        // Set sentinel to prevent retry and add a note for admin visibility.
        if (!appointment.trackingCode) {
          logger.error(
            { checkId, appointmentId: appointment.id, userEmail: appointment.userEmail },
            'Appointment missing tracking code - skipping feedback form email to prevent infinite retry'
          );
          // No tracking code → skip the send; flip the sentinel to a
          // real timestamp so we don't retry next tick (admin notes
          // surface the manual-send required state).
          await confirmSentinelClaim(appointment.id, 'feedbackFormSentAt', now);
          try {
            await prisma.appointmentRequest.update({
              where: { id: appointment.id },
              data: {
                notes: `${appointment.notes || ''}\n[SYSTEM ALERT ${new Date().toISOString()}]: Feedback form email skipped - missing tracking code. Admin must send manually after assigning a tracking code.`,
                isStale: true,
              },
              select: { id: true },
            });
          } catch {
            // Ignore - already logged main issue
          }
          skipped++;
          continue;
        }

        await this.sendFeedbackFormEmail(appointment);

        // Send therapist feedback notification (same trigger as user feedback form)
        await this.sendTherapistFeedbackNotificationEmail(appointment);

        // Log follow_up_sent audit event
        auditEventService.log(appointment.id, 'follow_up_sent', 'system', {
          followUpType: 'feedback_form',
        });

        // FIX B5: confirm via the helper so the sentinel-still-ours
        // precondition is enforced. Status transition is handled
        // separately by the lifecycle service.
        const confirmed = await confirmSentinelClaim(appointment.id, 'feedbackFormSentAt', now);

        // FIX B5: Verify update succeeded
        if (!confirmed) {
          logger.error(
            { checkId, appointmentId: appointment.id },
            'ALERT: Feedback form email sent but sentinel update failed - possible duplicate'
          );
          try {
            await prisma.appointmentRequest.update({
              where: { id: appointment.id },
              data: {
                notes: `${appointment.notes || ''}\n[SYSTEM ALERT ${new Date().toISOString()}]: feedbackForm email sent but tracking update failed - review for duplicates`,
              },
              select: { id: true },
            });
          } catch {
            // Ignore - already logged main issue
          }
        } else {
          // Use lifecycle service for status transition (audit trail, side effects)
          try {
            await appointmentLifecycleService.transitionToFeedbackRequested({
              appointmentId: appointment.id,
              source: 'system',
            });
          } catch (transitionError) {
            // FIX #10: Transition failed — reset sentinel so next cycle retries both email + transition
            logger.error(
              { checkId, appointmentId: appointment.id, error: transitionError },
              'Feedback form lifecycle transition failed - resetting sentinel to retry next cycle'
            );
            try {
              await prisma.appointmentRequest.update({
                where: { id: appointment.id },
                data: { feedbackFormSentAt: null },
                select: { id: true },
              });
            } catch (resetError) {
              logger.error(
                { checkId, appointmentId: appointment.id, error: resetError },
                'Failed to reset feedbackFormSentAt sentinel after transition failure'
              );
            }
            continue;
          }
          sent++;
          logger.info(
            { checkId, appointmentId: appointment.id, userEmail: appointment.userEmail },
            'Sent feedback form email and transitioned to feedback_requested'
          );
        }
      } catch (error) {
        // On failure, reset to null so it can be retried
        await prisma.appointmentRequest.update({
          where: { id: appointment.id },
          data: { feedbackFormSentAt: null },
          select: { id: true },
        });

        logger.error(
          { checkId, appointmentId: appointment.id, error },
          'Failed to send feedback form email - will retry next cycle'
        );
      }
    }

    if (sent > 0 || skipped > 0) {
      logger.info({ checkId, sent, skipped, checked: candidates.length }, 'Feedback form processing complete');
    }
  }

  /**
   * Send meeting link check email to the user (using configurable template)
   */
  private async sendMeetingLinkCheckEmail(appointment: {
    id: string;
    userName: string | null;
    userEmail: string;
    therapistName: string;
    confirmedDateTime: string | null;
    confirmedDateTimeParsed: Date | null;
    gmailThreadId: string | null;
  }): Promise<void> {
    // Address the recipient by first name only — see utils/first-name.ts.
    const userName = firstName(appointment.userName);
    const therapistFirstName = firstName(appointment.therapistName);

    // Meeting-link-check goes to the user; format the time in their local zone.
    const recipientTz = await resolveRecipientTimezone(appointment.userEmail);
    const formattedDateTime = await formatEmailDateFromSettings(
      appointment.confirmedDateTimeParsed,
      appointment.confirmedDateTime,
      recipientTz ?? undefined,
    );

    const subject = await getEmailSubject('meetingLinkCheck', {
      therapistName: therapistFirstName,
    });
    const body = await getEmailBody('meetingLinkCheck', {
      userName,
      therapistName: therapistFirstName,
      confirmedDateTime: formattedDateTime,
    });

    await emailProcessingService.sendEmail({
      to: appointment.userEmail,
      subject,
      body,
      threadId: appointment.gmailThreadId || undefined,
    });
  }

  /**
   * Send feedback form email to the user (NOT the therapist) - using configurable template
   *
   * Uses the native feedback form with tracking code pre-fill when available.
   * Falls back to configured external form URL if tracking code is not available.
   */
  private async sendFeedbackFormEmail(appointment: {
    id: string;
    userName: string | null;
    userEmail: string;
    therapistName: string;
    trackingCode: string | null;
    gmailThreadId: string | null;
  }): Promise<void> {
    const userName = firstName(appointment.userName);
    const therapistFirstName = firstName(appointment.therapistName);

    // Build feedback form URL using native form with tracking code
    if (!appointment.trackingCode) {
      logger.warn(
        { appointmentId: appointment.id, userEmail: appointment.userEmail },
        'Appointment missing tracking code - cannot send feedback form'
      );
      throw new Error('Appointment missing tracking code');
    }

    const webAppUrl = await getSettingValue<string>('weeklyMailing.webAppUrl');
    const baseUrl = webAppUrl.replace(/\/$/, '');
    // Embed an HMAC-signed token bound to this appointment ID. The submit
    // endpoint requires it before transitioning to `completed`, blocking
    // tracking-code enumeration attacks.
    const feedbackToken = generateFeedbackToken(appointment.id);
    const feedbackFormUrl = `${baseUrl}/feedback/${appointment.trackingCode}?fk=${encodeURIComponent(feedbackToken)}`;

    const subject = await getEmailSubject('feedbackForm', {
      therapistName: therapistFirstName,
    });
    const body = await getEmailBody('feedbackForm', {
      userName,
      therapistName: therapistFirstName,
      feedbackFormUrl,
    });

    await emailProcessingService.sendEmail({
      to: appointment.userEmail,
      subject,
      body,
      threadId: appointment.gmailThreadId || undefined,
    });
  }

  /**
   * Send post-session notification to therapist with invoicing details.
   * Triggered at the same time as the user feedback form email.
   * Gated by the notifications.email.therapistFeedbackNotification setting.
   */
  private async sendTherapistFeedbackNotificationEmail(appointment: {
    id: string;
    userName: string | null;
    therapistName: string;
    therapistEmail: string;
    therapistGmailThreadId: string | null;
  }): Promise<void> {
    // Check if therapist feedback notification is enabled
    const enabled = await getSettingValue<boolean>('notifications.email.therapistFeedbackNotification');
    if (!enabled) {
      logger.debug(
        { appointmentId: appointment.id },
        'Therapist feedback notification disabled - skipping'
      );
      return;
    }

    const therapistFirstName = firstName(appointment.therapistName);
    const clientFirstName = firstName(appointment.userName, 'your client');

    const subject = await getEmailSubject('therapistFeedbackNotification', {
      therapistFirstName,
      clientFirstName,
    });
    const body = await getEmailBody('therapistFeedbackNotification', {
      therapistFirstName,
      clientFirstName,
    });

    await emailProcessingService.sendEmail({
      to: appointment.therapistEmail,
      subject,
      body,
      threadId: appointment.therapistGmailThreadId || undefined,
    });

    logger.info(
      { appointmentId: appointment.id, therapistEmail: appointment.therapistEmail },
      'Sent therapist feedback notification email'
    );
  }

  /**
   * Send feedback reminder emails (chaser for feedback form)
   *
   * Rules:
   * - Send X hours after feedback form was sent (configurable, default 48h)
   * - Only for appointments in feedback_requested status
   * - Skip if feedback already received (status = completed)
   * - Skip if already sent reminder
   *
   * Uses optimistic locking pattern to prevent duplicates
   */
  private async processFeedbackReminders(checkId: string): Promise<void> {
    const now = new Date();

    // Check if feedback reminders are enabled
    const feedbackReminderEnabled = await getSettingValue<boolean>('notifications.email.feedbackReminder');
    if (!feedbackReminderEnabled) {
      logger.debug({ checkId }, 'Feedback reminders disabled - skipping');
      return;
    }

    // Get configurable delay (default 48 hours after feedback form sent)
    const reminderDelayHours = await getSettingValue<number>('postBooking.feedbackReminderDelayHours');
    const reminderDelayMs = reminderDelayHours * 60 * 60 * 1000;

    // Find appointments that:
    // - Are in feedback_requested status (feedback form sent, no response yet)
    // - Had feedback form sent more than X hours ago
    // - Haven't had reminder sent yet
    const candidates = await prisma.appointmentRequest.findMany({
      where: {
        status: APPOINTMENT_STATUS.FEEDBACK_REQUESTED,
        feedbackFormSentAt: {
          not: null,
          lt: new Date(now.getTime() - reminderDelayMs), // Sent more than X hours ago
        },
        feedbackReminderSentAt: null,
      },
      select: {
        id: true,
        userName: true,
        userEmail: true,
        therapistName: true,
        gmailThreadId: true,
        trackingCode: true,
        feedbackFormSentAt: true,
      },
      take: BATCH_SIZE,
      orderBy: { feedbackFormSentAt: 'asc' }, // Process oldest first
    });

    if (candidates.length === 0) {
      return;
    }

    let sent = 0;
    let skipped = 0;

    for (const appointment of candidates) {
      // OPTIMISTIC LOCKING: claim via the shared sentinel helper. The
      // status precondition keeps the claim scoped to rows still
      // waiting for feedback.
      const claimed = await tryClaimSentinel(appointment.id, 'feedbackReminderSentAt', {
        extraWhere: { status: APPOINTMENT_STATUS.FEEDBACK_REQUESTED },
      });
      if (!claimed) {
        logger.debug(
          { checkId, appointmentId: appointment.id },
          'Feedback reminder already being processed or status changed'
        );
        continue;
      }

      try {
        await this.sendFeedbackReminderEmail(appointment);

        // Log follow_up_sent audit event
        auditEventService.log(appointment.id, 'follow_up_sent', 'system', {
          followUpType: 'feedback_reminder',
        });

        // Atomic confirm — sentinel-still-ours precondition enforced by
        // the helper.
        const confirmed = await confirmSentinelClaim(appointment.id, 'feedbackReminderSentAt', now);

        if (!confirmed) {
          logger.error(
            { checkId, appointmentId: appointment.id },
            'ALERT: Feedback reminder email sent but sentinel update failed - possible duplicate'
          );
        } else {
          sent++;
          logger.info(
            { checkId, appointmentId: appointment.id, userEmail: appointment.userEmail },
            'Sent feedback reminder email'
          );
        }
      } catch (error) {
        // On failure, release the sentinel so it can be retried next
        // tick. The release helper guards on `=== EPOCH_SENTINEL` so we
        // can't accidentally null out a real timestamp another writer
        // just wrote.
        await releaseSentinelClaim(appointment.id, 'feedbackReminderSentAt');

        logger.error(
          { checkId, appointmentId: appointment.id, error },
          'Failed to send feedback reminder email - will retry next cycle'
        );
      }
    }

    if (sent > 0 || skipped > 0) {
      logger.info({ checkId, sent, skipped, checked: candidates.length }, 'Feedback reminder processing complete');
    }
  }

  /**
   * Send feedback reminder email to the user
   */
  private async sendFeedbackReminderEmail(appointment: {
    id: string;
    userName: string | null;
    userEmail: string;
    therapistName: string;
    trackingCode: string | null;
    gmailThreadId: string | null;
  }): Promise<void> {
    const userName = firstName(appointment.userName);
    const therapistFirstName = firstName(appointment.therapistName);

    // Build feedback form URL using native form with tracking code
    if (!appointment.trackingCode) {
      logger.warn(
        { appointmentId: appointment.id, userEmail: appointment.userEmail },
        'Appointment missing tracking code - cannot send feedback reminder'
      );
      throw new Error('Appointment missing tracking code');
    }

    const webAppUrl = await getSettingValue<string>('weeklyMailing.webAppUrl');
    const baseUrl = webAppUrl.replace(/\/$/, '');
    const feedbackToken = generateFeedbackToken(appointment.id);
    const feedbackFormUrl = `${baseUrl}/feedback/${appointment.trackingCode}?fk=${encodeURIComponent(feedbackToken)}`;

    const subject = await getEmailSubject('feedbackReminder', {
      therapistName: therapistFirstName,
    });
    const body = await getEmailBody('feedbackReminder', {
      userName,
      therapistName: therapistFirstName,
      feedbackFormUrl,
    });

    await emailProcessingService.sendEmail({
      to: appointment.userEmail,
      subject,
      body,
      threadId: appointment.gmailThreadId || undefined,
    });
  }

  /**
   * Send session reminder email to either user or therapist (Edge Case #6)
   */
  private async sendSessionReminderEmail(
    appointment: {
      id: string;
      userName: string | null;
      userEmail: string;
      therapistName: string;
      therapistEmail: string;
      confirmedDateTime: string | null;
      confirmedDateTimeParsed: Date | null;
      gmailThreadId: string | null;
      therapistGmailThreadId: string | null;
    },
    recipient: 'user' | 'therapist'
  ): Promise<void> {
    const isUser = recipient === 'user';
    const recipientName = isUser
      ? firstName(appointment.userName)
      : firstName(appointment.therapistName);
    const recipientEmail = isUser ? appointment.userEmail : appointment.therapistEmail;
    const threadId = isUser ? appointment.gmailThreadId : appointment.therapistGmailThreadId;
    const otherPartyName = isUser
      ? firstName(appointment.therapistName)
      : firstName(appointment.userName, 'your client');

    // Format the date in the recipient's local timezone (their country's
    // default zone) — falls back to the platform timezone if unknown.
    const recipientTz = await resolveRecipientTimezone(recipientEmail);
    const formattedDateTime = await formatEmailDateFromSettings(
      appointment.confirmedDateTimeParsed,
      appointment.confirmedDateTime,
      recipientTz ?? undefined,
    );

    const subject = await getEmailSubject('sessionReminder', {
      therapistName: appointment.therapistName,
      recipientType: recipient,
    });

    const body = await getEmailBody('sessionReminder', {
      recipientName,
      otherPartyName,
      confirmedDateTime: formattedDateTime,
      recipientType: recipient,
    });

    await emailProcessingService.sendEmail({
      to: recipientEmail,
      subject,
      body,
      threadId: threadId || undefined,
    });
  }

  /**
   * Clear parse failure tracking (useful for testing or manual intervention)
   */
  clearParseFailures(): void {
    const count = this.parseFailures.size;
    this.parseFailures.clear();
    logger.info({ count }, 'Cleared parse failure tracking');
  }

  /**
   * Get appointments with parse failures for manual review
   */
  getParseFailures(): { appointmentId: string; attempts: number; lastAttempt: number; firstFailure: number }[] {
    return Array.from(this.parseFailures.entries()).map(([appointmentId, entry]) => ({
      appointmentId,
      attempts: entry.count,
      lastAttempt: entry.lastAttempt,
      firstFailure: entry.firstFailure,
    }));
  }
}

export const postBookingFollowupService = new PostBookingFollowupService();
