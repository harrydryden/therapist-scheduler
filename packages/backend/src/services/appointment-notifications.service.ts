/**
 * Appointment Notifications Service
 *
 * Extracted from AppointmentLifecycleService to separate notification concerns
 * (Slack + email) from state machine logic.
 *
 * This service handles:
 * - Slack notifications for appointment status changes
 * - Email notifications to clients and therapists
 * - Notification settings (toggle checks)
 *
 * All notification dispatches are fire-and-forget via runBackgroundTask.
 */

import { logger } from '../utils/logger';
import { slackNotificationService } from './slack-notification.service';
import { emailProcessingService } from './email-processing.service';
import { getSettingValues } from './settings.service';
import { getEmailSubject, getEmailBody } from '../utils/email-templates';
import { formatEmailDateFromSettings } from '../utils/email-date-formatter';
import { runBackgroundTask } from '../utils/background-task';
import type { TransitionSource } from './appointment-lifecycle.service';

// ============================================
// Notification Settings
// ============================================

export interface NotificationSettings {
  slack: {
    requested: boolean;
    confirmed: boolean;
    completed: boolean;
    cancelled: boolean;
    escalation: boolean;
  };
  email: {
    clientConfirmation: boolean;
    therapistConfirmation: boolean;
    sessionReminder: boolean;
    feedbackForm: boolean;
    clientCancellation: boolean;
    therapistCancellation: boolean;
  };
}

export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
  slack: {
    requested: true,
    confirmed: true,
    completed: true,
    cancelled: true,
    escalation: true,
  },
  email: {
    clientConfirmation: true,
    therapistConfirmation: true,
    sessionReminder: true,
    feedbackForm: true,
    clientCancellation: true,
    therapistCancellation: true,
  },
};

// ============================================
// Notification Method Parameter Types
// ============================================

export interface NotifyConfirmedParams {
  appointmentId: string;
  source: TransitionSource;
  adminId?: string;
  userName: string | null;
  userEmail: string;
  therapistName: string | null;
  therapistEmail: string | null;
  confirmedDateTime: string;
  confirmedDateTimeParsed?: Date | null;
  sendEmails: boolean;
}

export interface NotifyCompletedParams {
  appointmentId: string;
  source: TransitionSource;
  adminId?: string;
  userName: string | null;
  therapistName: string;
  feedbackSubmissionId?: string;
  feedbackData?: Record<string, string>;
}

export interface NotifyCancelledParams {
  appointmentId: string;
  source: TransitionSource;
  adminId?: string;
  cancelledBy: 'client' | 'therapist' | 'admin' | 'system';
  reason: string;
  userName: string | null;
  userEmail: string;
  therapistName: string;
  therapistEmail: string;
  confirmedDateTime: string | null;
  confirmedDateTimeParsed: Date | null;
  gmailThreadId: string | null;
  therapistGmailThreadId: string | null;
}

export interface NotifyAdminForceUpdateParams {
  appointmentId: string;
  adminId?: string;
  userName: string | null;
  therapistName: string | null;
  newStatus: string;
  confirmedDateTime: string | null | undefined;
}

// ============================================
// Service Implementation
// ============================================

class AppointmentNotificationsService {
  /**
   * Get notification settings from admin settings.
   * OPTIMIZATION: Fetch all settings in parallel instead of sequentially.
   */
  async getNotificationSettings(): Promise<NotificationSettings> {
    try {
      // Single batch DB query instead of 11 individual calls
      const keys = [
        'notifications.slack.requested',
        'notifications.slack.confirmed',
        'notifications.slack.completed',
        'notifications.slack.cancelled',
        'notifications.slack.escalation',
        'notifications.email.clientConfirmation',
        'notifications.email.therapistConfirmation',
        'notifications.email.sessionReminder',
        'notifications.email.feedbackForm',
        'notifications.email.clientCancellation',
        'notifications.email.therapistCancellation',
      ] as const;

      const settingsMap = await getSettingValues<boolean>([...keys]);
      const get = (key: typeof keys[number], fallback: boolean) =>
        settingsMap.get(key) ?? fallback;

      return {
        slack: {
          requested: get('notifications.slack.requested', DEFAULT_NOTIFICATION_SETTINGS.slack.requested),
          confirmed: get('notifications.slack.confirmed', DEFAULT_NOTIFICATION_SETTINGS.slack.confirmed),
          completed: get('notifications.slack.completed', DEFAULT_NOTIFICATION_SETTINGS.slack.completed),
          cancelled: get('notifications.slack.cancelled', DEFAULT_NOTIFICATION_SETTINGS.slack.cancelled),
          escalation: get('notifications.slack.escalation', DEFAULT_NOTIFICATION_SETTINGS.slack.escalation),
        },
        email: {
          clientConfirmation: get('notifications.email.clientConfirmation', DEFAULT_NOTIFICATION_SETTINGS.email.clientConfirmation),
          therapistConfirmation: get('notifications.email.therapistConfirmation', DEFAULT_NOTIFICATION_SETTINGS.email.therapistConfirmation),
          sessionReminder: get('notifications.email.sessionReminder', DEFAULT_NOTIFICATION_SETTINGS.email.sessionReminder),
          feedbackForm: get('notifications.email.feedbackForm', DEFAULT_NOTIFICATION_SETTINGS.email.feedbackForm),
          clientCancellation: get('notifications.email.clientCancellation', DEFAULT_NOTIFICATION_SETTINGS.email.clientCancellation),
          therapistCancellation: get('notifications.email.therapistCancellation', DEFAULT_NOTIFICATION_SETTINGS.email.therapistCancellation),
        },
      };
    } catch {
      return DEFAULT_NOTIFICATION_SETTINGS;
    }
  }

  /**
   * Send notifications for a confirmed appointment.
   * - Slack notification (if enabled)
   * - Client confirmation email (if enabled and sendEmails is true)
   * - Therapist confirmation email (if enabled and sendEmails is true)
   */
  async notifyConfirmed(params: NotifyConfirmedParams): Promise<void> {
    const {
      appointmentId,
      source,
      adminId,
      userName,
      userEmail,
      therapistName,
      therapistEmail,
      confirmedDateTime,
      confirmedDateTimeParsed,
      sendEmails,
    } = params;
    const logContext = { appointmentId, source, adminId };

    // Get notification settings
    const settings = await this.getNotificationSettings();

    // Send Slack notification (non-blocking, tracked)
    if (settings.slack.confirmed) {
      runBackgroundTask(
        () => slackNotificationService.notifyAppointmentConfirmed(
          appointmentId,
          userName,
          therapistName,
          confirmedDateTime
        ),
        {
          name: 'slack-notify-confirmed',
          context: logContext,
          retry: true,
          maxRetries: 2,
        }
      );
    }

    // Send confirmation emails (non-blocking, tracked)
    if (sendEmails) {
      const therapistFirstName = (therapistName || 'there').split(' ')[0];
      const clientFirstName = (userName || 'the client').split(' ')[0];

      // Send client confirmation email
      if (settings.email.clientConfirmation) {
        runBackgroundTask(
          async () => {
            // Format the date in human-friendly relative format
            const formattedDateTime = await formatEmailDateFromSettings(
              confirmedDateTimeParsed,
              confirmedDateTime,
            );

            // Use allSettled to handle partial failures gracefully
            const results = await Promise.allSettled([
              getEmailSubject('clientConfirmation', {
                therapistName: therapistName || 'your therapist',
                confirmedDateTime: formattedDateTime,
              }),
              getEmailBody('clientConfirmation', {
                userName: userName || 'there',
                therapistName: therapistName || 'your therapist',
                confirmedDateTime: formattedDateTime,
              }),
            ]);

            // Check for failures in template loading
            const subjectResult = results[0];
            const bodyResult = results[1];

            if (subjectResult.status === 'rejected' || bodyResult.status === 'rejected') {
              const failures = results
                .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
                .map(r => r.reason);
              throw new Error(`Template loading failed: ${failures.join(', ')}`);
            }

            await emailProcessingService.sendEmail({
              to: userEmail,
              subject: subjectResult.value,
              body: bodyResult.value,
            });
            logger.info(
              { ...logContext, userEmail },
              'Sent confirmation email to client'
            );
          },
          {
            name: 'email-client-confirmation',
            context: { ...logContext, userEmail },
            retry: true,
            maxRetries: 2,
          }
        );
      }

      // Send therapist confirmation email
      if (settings.email.therapistConfirmation && therapistEmail) {
        runBackgroundTask(
          async () => {
            // Format the date in human-friendly relative format
            const formattedDateTime = await formatEmailDateFromSettings(
              confirmedDateTimeParsed,
              confirmedDateTime,
            );

            const results = await Promise.allSettled([
              getEmailSubject('therapistConfirmation', { confirmedDateTime: formattedDateTime }),
              getEmailBody('therapistConfirmation', {
                therapistFirstName,
                clientFirstName,
                userEmail,
                confirmedDateTime: formattedDateTime,
              }),
            ]);

            const subjectResult = results[0];
            const bodyResult = results[1];

            if (subjectResult.status === 'rejected' || bodyResult.status === 'rejected') {
              const failures = results
                .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
                .map(r => r.reason);
              throw new Error(`Template loading failed: ${failures.join(', ')}`);
            }

            await emailProcessingService.sendEmail({
              to: therapistEmail,
              subject: subjectResult.value,
              body: bodyResult.value,
            });
            logger.info(
              { ...logContext, therapistEmail },
              'Sent confirmation email to therapist'
            );
          },
          {
            name: 'email-therapist-confirmation',
            context: { ...logContext, therapistEmail },
            retry: true,
            maxRetries: 2,
          }
        );
      }
    }
  }

  /**
   * Send notifications for a completed appointment.
   * - Slack notification (if enabled, or always when feedback is attached)
   */
  async notifyCompleted(params: NotifyCompletedParams): Promise<void> {
    const {
      appointmentId,
      source,
      adminId,
      userName,
      therapistName,
      feedbackSubmissionId,
      feedbackData,
    } = params;
    const logContext = { appointmentId, source, adminId };

    // Always notify when feedback is attached (the team needs to see feedback scores
    // regardless of the generic completed-notification toggle). For non-feedback
    // completions (e.g. admin-triggered), respect the admin setting.
    const settings = await this.getNotificationSettings();
    if (feedbackSubmissionId || settings.slack.completed) {
      runBackgroundTask(
        () => slackNotificationService.notifyAppointmentCompleted(
          appointmentId,
          userName,
          therapistName,
          feedbackSubmissionId,
          feedbackData
        ),
        {
          name: 'slack-notify-completed',
          context: logContext,
          retry: true,
          maxRetries: 2,
        }
      );
    }
  }

  /**
   * Send notifications for a cancelled appointment.
   * - Slack notification (if enabled)
   * - Client cancellation email (if enabled)
   * - Therapist cancellation email (if enabled and therapist was previously contacted)
   */
  async notifyCancelled(params: NotifyCancelledParams): Promise<void> {
    const {
      appointmentId,
      source,
      adminId,
      cancelledBy,
      reason,
      userName,
      userEmail,
      therapistName,
      therapistEmail,
      confirmedDateTime,
      confirmedDateTimeParsed,
      gmailThreadId,
      therapistGmailThreadId,
    } = params;
    const logContext = { appointmentId, source, adminId, cancelledBy };

    // Get notification settings
    const settings = await this.getNotificationSettings();

    // Send Slack notification (non-blocking, tracked)
    if (settings.slack.cancelled) {
      runBackgroundTask(
        () => slackNotificationService.notifyAppointmentCancelled(
          appointmentId,
          userName,
          therapistName,
          reason,
          cancelledBy
        ),
        {
          name: 'slack-notify-cancelled',
          context: logContext,
          retry: true,
          maxRetries: 2,
        }
      );
    }

    // Send cancellation emails (non-blocking, tracked)
    const therapistFirstName = (therapistName || 'your therapist').split(' ')[0];
    const clientFirstName = (userName || 'the client').split(' ')[0];
    // Only include reason in the email to the *other* party (empty string hides the line)
    const cancellationReasonForClient = cancelledBy === 'therapist' ? `\nReason: ${reason}` : '';
    const cancellationReasonForTherapist = cancelledBy === 'client' ? `\nReason: ${reason}` : '';

    // Send client cancellation email
    if (settings.email.clientCancellation && userEmail) {
      runBackgroundTask(
        async () => {
          // Format the date in human-friendly relative format
          const formattedDateTime = await formatEmailDateFromSettings(
            confirmedDateTimeParsed,
            confirmedDateTime,
          );

          const results = await Promise.allSettled([
            getEmailSubject('clientCancellation', {
              therapistName: therapistFirstName,
            }),
            getEmailBody('clientCancellation', {
              userName: userName || 'there',
              therapistName: therapistFirstName,
              confirmedDateTime: formattedDateTime,
              cancellationReason: cancellationReasonForClient,
            }),
          ]);

          const subjectResult = results[0];
          const bodyResult = results[1];

          if (subjectResult.status === 'rejected' || bodyResult.status === 'rejected') {
            const failures = results
              .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
              .map(r => r.reason);
            throw new Error(`Template loading failed: ${failures.join(', ')}`);
          }

          await emailProcessingService.sendEmail({
            to: userEmail,
            subject: subjectResult.value,
            body: bodyResult.value,
            threadId: gmailThreadId || undefined,
          });
          logger.info(
            { ...logContext, userEmail },
            'Sent cancellation email to client'
          );
        },
        {
          name: 'email-client-cancellation',
          context: { ...logContext, userEmail },
          retry: true,
          maxRetries: 2,
        }
      );
    }

    // Send therapist cancellation email — only if the therapist was already contacted
    // (i.e. an email thread exists with them, meaning the user's name was shared).
    // If we never emailed the therapist, there is nothing to notify them about.
    if (settings.email.therapistCancellation && therapistEmail && therapistGmailThreadId) {
      runBackgroundTask(
        async () => {
          // Format the date in human-friendly relative format
          const formattedDateTime = await formatEmailDateFromSettings(
            confirmedDateTimeParsed,
            confirmedDateTime,
          );

          const results = await Promise.allSettled([
            getEmailSubject('therapistCancellation', {
              clientFirstName,
            }),
            getEmailBody('therapistCancellation', {
              therapistFirstName,
              clientFirstName,
              confirmedDateTime: formattedDateTime,
              cancellationReason: cancellationReasonForTherapist,
            }),
          ]);

          const subjectResult = results[0];
          const bodyResult = results[1];

          if (subjectResult.status === 'rejected' || bodyResult.status === 'rejected') {
            const failures = results
              .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
              .map(r => r.reason);
            throw new Error(`Template loading failed: ${failures.join(', ')}`);
          }

          await emailProcessingService.sendEmail({
            to: therapistEmail,
            subject: subjectResult.value,
            body: bodyResult.value,
            threadId: therapistGmailThreadId || undefined,
          });
          logger.info(
            { ...logContext, therapistEmail },
            'Sent cancellation email to therapist'
          );
        },
        {
          name: 'email-therapist-cancellation',
          context: { ...logContext, therapistEmail },
          retry: true,
          maxRetries: 2,
        }
      );
    }
  }

  /**
   * Send notifications for admin force-updated appointments.
   * Only Slack notifications — emails are intentionally skipped for admin overrides
   * since the admin is making the change consciously.
   */
  async notifyAdminForceUpdate(params: NotifyAdminForceUpdateParams): Promise<void> {
    const {
      appointmentId,
      adminId,
      userName,
      therapistName,
      newStatus,
      confirmedDateTime,
    } = params;
    const logContext = { appointmentId, adminId };

    const settings = await this.getNotificationSettings();

    if (newStatus === 'confirmed' && settings.slack.confirmed) {
      runBackgroundTask(
        () => slackNotificationService.notifyAppointmentConfirmed(
          appointmentId,
          userName || 'Unknown',
          therapistName || 'Unknown',
          confirmedDateTime || 'TBD'
        ),
        { name: 'slack-notify-admin-confirmed', context: logContext, retry: true, maxRetries: 2 }
      );
    }

    if (newStatus === 'completed' && settings.slack.completed) {
      runBackgroundTask(
        () => slackNotificationService.notifyAppointmentCompleted(
          appointmentId,
          userName || 'Unknown',
          therapistName || 'Unknown',
        ),
        { name: 'slack-notify-admin-completed', context: logContext, retry: true, maxRetries: 2 }
      );
    }

    if (newStatus === 'cancelled' && settings.slack.cancelled) {
      runBackgroundTask(
        () => slackNotificationService.notifyAppointmentCancelled(
          appointmentId,
          userName || 'Unknown',
          therapistName || 'Unknown',
          'Admin override',
          'admin'
        ),
        { name: 'slack-notify-admin-cancelled', context: logContext, retry: true, maxRetries: 2 }
      );
    }
  }
}

export const appointmentNotificationsService = new AppointmentNotificationsService();
