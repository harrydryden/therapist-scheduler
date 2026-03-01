/**
 * Notification Dispatcher Service
 *
 * Central coordination layer for ALL outbound notifications across the system.
 * This service is the single entry point that:
 *
 * 1. Checks admin-configured notification settings (on/off toggles)
 * 2. Dispatches to Slack via slackNotificationService
 * 3. Emits SSE events so the admin dashboard receives real-time updates
 * 4. Provides consistent error handling and logging
 *
 * Before this refactoring, notification dispatch was scattered across 10+ files
 * (routes, services, utilities) with inconsistent settings checks. Now every
 * notification flows through this dispatcher.
 *
 * The Slack service itself retains responsibility for formatting, circuit
 * breaker protection, and retry queuing. This dispatcher only decides
 * *whether* and *when* to send, not *how*.
 */

import { logger } from '../utils/logger';
import { slackNotificationService } from './slack-notification.service';
import { sseService, type SSEEvent } from './sse.service';
import { getSettingValues } from './settings.service';
import { runBackgroundTask } from '../utils/background-task';

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

const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
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
// Dispatcher Implementation
// ============================================

class NotificationDispatcher {
  /**
   * Load notification settings from the admin settings store.
   * Uses a single batch DB query for all keys.
   */
  async getNotificationSettings(): Promise<NotificationSettings> {
    try {
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

  // ============================================
  // Appointment Lifecycle Notifications
  // ============================================

  /**
   * Notify: new appointment request created.
   * Checks `notifications.slack.requested` setting.
   */
  async appointmentCreated(params: {
    appointmentId: string;
    therapistName: string;
    userEmail: string;
  }): Promise<void> {
    const settings = await this.getNotificationSettings();
    if (!settings.slack.requested) return;

    runBackgroundTask(
      () => slackNotificationService.notifyAppointmentCreated(
        params.appointmentId,
        params.therapistName,
        params.userEmail
      ),
      {
        name: 'slack-notify-requested',
        context: { appointmentId: params.appointmentId },
        retry: true,
        maxRetries: 2,
      }
    );
  }

  /**
   * Notify: appointment confirmed with a date/time.
   * Checks `notifications.slack.confirmed` setting.
   */
  async appointmentConfirmed(params: {
    appointmentId: string;
    therapistName: string;
    confirmedDateTime: string;
  }): Promise<void> {
    const settings = await this.getNotificationSettings();
    if (!settings.slack.confirmed) return;

    runBackgroundTask(
      () => slackNotificationService.notifyAppointmentConfirmed(
        params.appointmentId,
        params.therapistName,
        params.confirmedDateTime
      ),
      {
        name: 'slack-notify-confirmed',
        context: { appointmentId: params.appointmentId },
        retry: true,
        maxRetries: 2,
      }
    );
  }

  /**
   * Notify: appointment completed (possibly with feedback).
   * Checks `notifications.slack.completed` setting, but always sends
   * when feedback data is attached (the team needs to see feedback scores).
   */
  async appointmentCompleted(params: {
    appointmentId: string;
    therapistName: string;
    feedbackSubmissionId?: string;
    feedbackData?: Record<string, string>;
  }): Promise<void> {
    const settings = await this.getNotificationSettings();

    // Always notify when feedback is attached; otherwise respect the setting
    if (!params.feedbackSubmissionId && !settings.slack.completed) return;

    runBackgroundTask(
      () => slackNotificationService.notifyAppointmentCompleted(
        params.appointmentId,
        params.therapistName,
        params.feedbackSubmissionId,
        params.feedbackData
      ),
      {
        name: 'slack-notify-completed',
        context: { appointmentId: params.appointmentId },
        retry: true,
        maxRetries: 2,
      }
    );
  }

  /**
   * Notify: appointment cancelled.
   * Checks `notifications.slack.cancelled` setting.
   */
  async appointmentCancelled(params: {
    appointmentId: string;
    therapistName: string;
    reason: string;
  }): Promise<void> {
    const settings = await this.getNotificationSettings();
    if (!settings.slack.cancelled) return;

    runBackgroundTask(
      () => slackNotificationService.notifyAppointmentCancelled(
        params.appointmentId,
        params.therapistName,
        params.reason
      ),
      {
        name: 'slack-notify-cancelled',
        context: { appointmentId: params.appointmentId },
        retry: true,
        maxRetries: 2,
      }
    );
  }

  // ============================================
  // Alert Notifications (always send + SSE)
  // ============================================

  /**
   * Alert: auto-escalation triggered (72h stall -> human control).
   * Checks `notifications.slack.escalation` setting.
   * Also emits SSE so the admin dashboard updates in real time.
   */
  async autoEscalation(params: {
    appointmentId: string;
    therapistName: string;
    stallDurationHours: number;
  }): Promise<void> {
    const settings = await this.getNotificationSettings();

    this.emitAlertSSE(params.appointmentId, 'auto-escalation');

    if (!settings.slack.escalation) return;

    runBackgroundTask(
      () => slackNotificationService.notifyAutoEscalation(
        params.appointmentId,
        params.therapistName,
        params.stallDurationHours
      ),
      {
        name: 'slack-notify-auto-escalation',
        context: { appointmentId: params.appointmentId },
        retry: true,
        maxRetries: 2,
      }
    );
  }

  /**
   * Alert: email thread divergence detected.
   * Always sends (critical operational alert).
   * Also emits SSE for real-time dashboard update.
   */
  async threadDivergence(params: {
    appointmentId: string;
    therapistName: string;
    divergenceType: string;
    description: string;
  }): Promise<void> {
    this.emitAlertSSE(params.appointmentId, 'thread-divergence');

    runBackgroundTask(
      () => slackNotificationService.notifyThreadDivergence(
        params.appointmentId,
        params.therapistName,
        params.divergenceType,
        params.description
      ),
      {
        name: 'slack-notify-thread-divergence',
        context: { appointmentId: params.appointmentId },
        retry: true,
        maxRetries: 2,
      }
    );
  }

  /**
   * Alert: email bounced.
   * Always sends (critical operational alert).
   */
  async emailBounce(params: {
    appointmentId: string;
    therapistName: string;
    bouncedEmail: string;
    bounceReason: string;
  }): Promise<void> {
    this.emitAlertSSE(params.appointmentId, 'email-bounce');

    runBackgroundTask(
      () => slackNotificationService.notifyEmailBounce(
        params.appointmentId,
        params.therapistName,
        params.bouncedEmail,
        params.bounceReason
      ),
      {
        name: 'slack-notify-email-bounce',
        context: { appointmentId: params.appointmentId },
        retry: true,
        maxRetries: 2,
      }
    );
  }

  /**
   * Alert: conversation stalled (activity but no forward progress).
   * Always sends (operational monitoring).
   */
  async conversationStall(params: {
    appointmentId: string;
    therapistName: string;
    stallDurationHours: number;
    lastToolFailure?: string;
  }): Promise<void> {
    this.emitAlertSSE(params.appointmentId, 'conversation-stall');

    runBackgroundTask(
      () => slackNotificationService.notifyConversationStall(
        params.appointmentId,
        params.therapistName,
        params.stallDurationHours,
        params.lastToolFailure
      ),
      {
        name: 'slack-notify-conversation-stall',
        context: { appointmentId: params.appointmentId },
        retry: true,
        maxRetries: 2,
      }
    );
  }

  /**
   * Alert: AI agent flagged conversation for human review.
   * Always sends (requires prompt human attention).
   */
  async humanReviewFlagged(params: {
    appointmentId: string;
    therapistName: string;
    reason: string;
  }): Promise<void> {
    this.emitAlertSSE(params.appointmentId, 'human-review-flagged');

    runBackgroundTask(
      () => slackNotificationService.notifyHumanReviewFlagged(
        params.appointmentId,
        params.therapistName,
        params.reason
      ),
      {
        name: 'slack-notify-human-review',
        context: { appointmentId: params.appointmentId },
        retry: true,
        maxRetries: 2,
      }
    );
  }

  /**
   * Alert: incoming email could not be matched after max retries.
   * Always sends (a real message was silently dropped).
   */
  async unmatchedEmailAbandoned(params: {
    messageId: string;
    from: string;
    subject: string;
    attempts: number;
  }): Promise<void> {
    runBackgroundTask(
      () => slackNotificationService.notifyUnmatchedEmailAbandoned(
        params.messageId,
        params.from,
        params.subject,
        params.attempts
      ),
      {
        name: 'slack-notify-unmatched-email',
        context: { messageId: params.messageId },
        retry: true,
        maxRetries: 2,
      }
    );
  }

  /**
   * Alert: special email handling (frustrated user, urgent, OOO, cancellation request).
   * Always sends (requires human attention).
   */
  async specialHandlingAlert(params: {
    appointmentId: string;
    therapistName: string;
    title: string;
    severity: 'low' | 'medium' | 'high' | 'critical';
    details: string;
    additionalFields?: Record<string, string>;
  }): Promise<void> {
    this.emitAlertSSE(params.appointmentId, 'special-handling');

    runBackgroundTask(
      () => slackNotificationService.sendAlert({
        title: params.title,
        severity: params.severity,
        appointmentId: params.appointmentId,
        therapistName: params.therapistName,
        details: params.details,
        additionalFields: params.additionalFields,
      }),
      {
        name: 'slack-notify-special-handling',
        context: { appointmentId: params.appointmentId },
        retry: true,
        maxRetries: 2,
      }
    );
  }

  // ============================================
  // Internal Helpers
  // ============================================

  /**
   * Emit an SSE event when an alert is raised, so the admin dashboard
   * can refresh alert data in real time instead of waiting for the
   * 30-second polling interval.
   */
  private emitAlertSSE(appointmentId: string, alertType: string): void {
    sseService.emit({
      type: 'appointment:activity',
      appointmentId,
      data: { activityType: `alert:${alertType}`, timestamp: new Date().toISOString() },
    });
  }
}

// Singleton instance
export const notificationDispatcher = new NotificationDispatcher();
