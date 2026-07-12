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
import { sendEmail } from '../core/email';
import { getSettingValues } from './settings.service';
import { runBackgroundTask } from '../utils/background-task';
import { runTrackedSideEffect, runReplayableTrackedSideEffect } from './side-effect-harness';
import {
  renderClientConfirmationEmail,
  renderTherapistConfirmationEmail,
  renderClientCancellationEmail,
  renderTherapistCancellationEmail,
} from './transition-email-renderers';
import type { TransitionSource } from '../domain/scheduling/lifecycle';

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
  /**
   * Post-update transition generation. Threaded into side-effect-tracker
   * idempotency keys so that re-confirmation after cancellation gets a
   * different key than the original confirmation's already-completed
   * Slack/email rows. The bump happens in the transition itself (e.g.
   * domain/scheduling/lifecycle/transitions/confirmed.ts).
   */
  transitionGeneration?: number;
}

export interface NotifyCompletedParams {
  appointmentId: string;
  source: TransitionSource;
  adminId?: string;
  userName: string | null;
  therapistName: string;
  feedbackSubmissionId?: string;
  feedbackData?: Record<string, string>;
  transitionGeneration?: number;
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
  transitionGeneration?: number;
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
      transitionGeneration,
    } = params;
    const logContext = { appointmentId, source, adminId };

    // Get notification settings
    const settings = await this.getNotificationSettings();

    // Send Slack notification (non-blocking, tracked persistently so transient
    // Slack outages survive process restarts via side-effect-retry.service)
    if (settings.slack.confirmed) {
      runTrackedSideEffect(
        appointmentId,
        'confirmed',
        'slack_notify_confirmed',
        () => slackNotificationService.notifyAppointmentConfirmed({
          appointmentId,
          therapistName: therapistName ?? 'unknown therapist',
          confirmedDateTime,
        }),
        {
          name: 'slack-notify-confirmed',
          context: logContext,
          retry: true,
          maxRetries: 2,
        },
        transitionGeneration,
      );
    }

    // Send confirmation emails (non-blocking, tracked)
    if (sendEmails) {
      // Send client confirmation email — replayable: payload rendered once
      // at registration time so the periodic retry runner replays the exact
      // localised subject/body if the original send fails.
      if (settings.email.clientConfirmation) {
        runReplayableTrackedSideEffect(
          appointmentId,
          'confirmed',
          'email_client_confirmation',
          {
            renderPayload: () =>
              renderClientConfirmationEmail({
                userEmail,
                userName,
                therapistName,
                confirmedDateTime,
                confirmedDateTimeParsed,
              }),
            execute: async (payload) => {
              await sendEmail({ to: payload.to, subject: payload.subject, body: payload.body });
              logger.info({ ...logContext, userEmail }, 'Sent confirmation email to client');
            },
          },
          {
            name: 'email-client-confirmation',
            context: { ...logContext, userEmail },
            retry: true,
            maxRetries: 2,
          },
          transitionGeneration,
        );
      }

      // Send therapist confirmation email — replayable.
      if (settings.email.therapistConfirmation && therapistEmail) {
        runReplayableTrackedSideEffect(
          appointmentId,
          'confirmed',
          'email_therapist_confirmation',
          {
            renderPayload: () =>
              renderTherapistConfirmationEmail({
                therapistEmail,
                therapistName,
                userName,
                userEmail,
                confirmedDateTime,
                confirmedDateTimeParsed,
              }),
            execute: async (payload) => {
              await sendEmail({ to: payload.to, subject: payload.subject, body: payload.body });
              logger.info({ ...logContext, therapistEmail }, 'Sent confirmation email to therapist');
            },
          },
          {
            name: 'email-therapist-confirmation',
            context: { ...logContext, therapistEmail },
            retry: true,
            maxRetries: 2,
          },
          transitionGeneration,
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
      transitionGeneration,
    } = params;
    const logContext = { appointmentId, source, adminId };

    // Always notify when feedback is attached (the team needs to see feedback scores
    // regardless of the generic completed-notification toggle). For non-feedback
    // completions (e.g. admin-triggered), respect the admin setting.
    const settings = await this.getNotificationSettings();
    if (feedbackSubmissionId || settings.slack.completed) {
      runTrackedSideEffect(
        appointmentId,
        'completed',
        'slack_notify_completed',
        () => slackNotificationService.notifyAppointmentCompleted({
          appointmentId,
          therapistName,
          feedbackSubmissionId,
          feedbackData,
        }),
        {
          name: 'slack-notify-completed',
          context: logContext,
          retry: true,
          maxRetries: 2,
        },
        transitionGeneration,
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
      transitionGeneration,
    } = params;
    const logContext = { appointmentId, source, adminId, cancelledBy };

    // Get notification settings
    const settings = await this.getNotificationSettings();

    // Send Slack notification (non-blocking, tracked persistently)
    if (settings.slack.cancelled) {
      runTrackedSideEffect(
        appointmentId,
        'cancelled',
        'slack_notify_cancelled',
        () => slackNotificationService.notifyAppointmentCancelled({
          appointmentId,
          therapistName,
          reason,
          cancelledBy,
        }),
        {
          name: 'slack-notify-cancelled',
          context: logContext,
          retry: true,
          maxRetries: 2,
        },
        transitionGeneration,
      );
    }

    // Send cancellation emails (non-blocking, tracked). Which template
    // each party gets — apology+voucher vs apology+reassurance vs neutral
    // — is selected from `cancelledBy` inside the renderers themselves
    // (renderClientCancellationEmail / renderTherapistCancellationEmail in
    // transition-email-renderers.ts). That's the single source of truth
    // for the branching; this service just decides whether to send at all
    // (settings + thread-exists guards below) and wires the renderer to
    // the tracked-side-effect harness.
    // ─── CLIENT EMAIL ────────────────────────────────────────────
    if (settings.email.clientCancellation && userEmail) {
      runReplayableTrackedSideEffect(
        appointmentId,
        'cancelled',
        'email_client_cancellation',
        {
          renderPayload: () =>
            renderClientCancellationEmail({
              userEmail,
              userName,
              therapistName,
              cancelledBy,
              reason,
              confirmedDateTime,
              confirmedDateTimeParsed,
              gmailThreadId,
            }),
          execute: async (payload) => {
            await sendEmail({
              to: payload.to,
              subject: payload.subject,
              body: payload.body,
              threadId: payload.threadId || undefined,
            });
            logger.info(
              { ...logContext, userEmail, cancelledBy },
              'Sent cancellation email to client',
            );
          },
        },
        {
          name: 'email-client-cancellation',
          context: { ...logContext, userEmail },
          retry: true,
          maxRetries: 2,
        },
        transitionGeneration,
      );
    }

    // ─── THERAPIST EMAIL ─────────────────────────────────────────
    // Only fires when the therapist was already contacted (i.e. an
    // email thread exists). If we never emailed the therapist,
    // there's nothing to notify them about — no surprise outreach.
    if (settings.email.therapistCancellation && therapistEmail && therapistGmailThreadId) {
      runReplayableTrackedSideEffect(
        appointmentId,
        'cancelled',
        'email_therapist_cancellation',
        {
          renderPayload: () =>
            renderTherapistCancellationEmail({
              therapistEmail,
              therapistName,
              userName,
              cancelledBy,
              reason,
              confirmedDateTime,
              confirmedDateTimeParsed,
              therapistGmailThreadId,
            }),
          execute: async (payload) => {
            await sendEmail({
              to: payload.to,
              subject: payload.subject,
              body: payload.body,
              threadId: payload.threadId || undefined,
            });
            logger.info(
              { ...logContext, therapistEmail, cancelledBy },
              'Sent cancellation email to therapist',
            );
          },
        },
        {
          name: 'email-therapist-cancellation',
          context: { ...logContext, therapistEmail },
          retry: true,
          maxRetries: 2,
        },
        transitionGeneration,
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
        () => slackNotificationService.notifyAppointmentConfirmed({
          appointmentId,
          therapistName: therapistName || 'Unknown',
          confirmedDateTime: confirmedDateTime || 'TBD',
        }),
        { name: 'slack-notify-admin-confirmed', context: logContext, retry: true, maxRetries: 2 }
      );
    }

    if (newStatus === 'completed' && settings.slack.completed) {
      runBackgroundTask(
        () => slackNotificationService.notifyAppointmentCompleted({
          appointmentId,
          therapistName: therapistName || 'Unknown',
        }),
        { name: 'slack-notify-admin-completed', context: logContext, retry: true, maxRetries: 2 }
      );
    }

    if (newStatus === 'cancelled' && settings.slack.cancelled) {
      runBackgroundTask(
        () => slackNotificationService.notifyAppointmentCancelled({
          appointmentId,
          therapistName: therapistName || 'Unknown',
          reason: 'Admin override',
          cancelledBy: 'admin',
        }),
        { name: 'slack-notify-admin-cancelled', context: logContext, retry: true, maxRetries: 2 }
      );
    }
  }
}

export const appointmentNotificationsService = new AppointmentNotificationsService();
