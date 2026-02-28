/**
 * Slack Notification Service
 *
 * Sends real-time notifications to Slack via incoming webhooks for:
 * - Auto-escalation (72h stall → human control)
 * - Thread divergence alerts
 * - Email bounce detection
 * - Conversation stalls needing attention
 * - Daily/weekly summaries
 *
 * Setup:
 * 1. Create a Slack app at https://api.slack.com/apps
 * 2. Enable "Incoming Webhooks"
 * 3. Add webhook to your desired channel
 * 4. Set SLACK_WEBHOOK_URL env var
 *
 * Optional: Set SLACK_WEBHOOK_URL_URGENT for critical alerts to a different channel
 */

import { logger } from '../utils/logger';
import { circuitBreakerRegistry, CircuitBreakerError } from '../utils/circuit-breaker';
import { withTimeout, DEFAULT_TIMEOUTS } from '../utils/timeout';
import { cacheManager } from '../utils/redis';

// Redis key for persisted notification queue
const SLACK_QUEUE_KEY = 'slack:notification:queue';
const SLACK_QUEUE_TTL = 86400; // 24 hours

// Slack circuit breaker configuration
const SLACK_CIRCUIT_CONFIG = {
  name: 'slack-webhook',
  failureThreshold: 5,
  resetTimeout: 30000, // 30 seconds
  successThreshold: 2,
  failureWindow: 60000, // 1 minute
};

// Get or create the Slack circuit breaker
const slackCircuitBreaker = circuitBreakerRegistry.getOrCreate(SLACK_CIRCUIT_CONFIG);

// Notification queue for retry (in-memory for simplicity, could be Redis for persistence)
interface QueuedNotification {
  message: SlackMessage;
  useUrgentChannel: boolean;
  queuedAt: Date;
  attempts: number;
}
const notificationQueue: QueuedNotification[] = [];
const MAX_QUEUE_SIZE = 100;

// Slack Block Kit types for rich message formatting
interface SlackTextBlock {
  type: 'section' | 'header' | 'divider' | 'context';
  text?: {
    type: 'mrkdwn' | 'plain_text';
    text: string;
    emoji?: boolean;
  };
  fields?: Array<{
    type: 'mrkdwn' | 'plain_text';
    text: string;
  }>;
  elements?: Array<{
    type: 'mrkdwn' | 'plain_text';
    text: string;
  }>;
}

interface SlackMessage {
  text: string; // Fallback text for notifications
  blocks?: SlackTextBlock[];
  unfurl_links?: boolean;
  unfurl_media?: boolean;
}

export type AlertSeverity = 'low' | 'medium' | 'high' | 'critical';

export interface SlackAlertOptions {
  title: string;
  severity: AlertSeverity;
  appointmentId?: string;
  therapistName?: string;
  details: string;
  additionalFields?: Record<string, string>;
  emoji?: string; // Override default severity emoji
  fallbackSuffix?: string; // Extra text appended to the plain-text fallback (push notifications)
}

// Emoji mapping for severity
const SEVERITY_EMOJI: Record<AlertSeverity, string> = {
  low: 'ℹ️',
  medium: '⚠️',
  high: '🔶',
  critical: '🚨',
};

// Color mapping for severity (used in attachments if needed)
const SEVERITY_COLOR: Record<AlertSeverity, string> = {
  low: '#36a64f',    // green
  medium: '#daa520', // goldenrod
  high: '#ff8c00',   // dark orange
  critical: '#dc3545', // red
};

/**
 * Escape user-provided text for safe inclusion in Slack mrkdwn blocks.
 * Prevents accidental formatting from *, _, ~, `, and entity confusion from &, <, >.
 */
function escapeSlackMrkdwn(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/([*_~`])/g, '\u200B$1');
}

class SlackNotificationService {
  private webhookUrl: string | null = null;
  private webhookUrlUrgent: string | null = null;
  private adminDashboardBaseUrl: string = 'https://free.spill.app/admin/dashboard';
  private enabled: boolean = false;

  constructor() {
    this.webhookUrl = process.env.SLACK_WEBHOOK_URL || null;
    this.webhookUrlUrgent = process.env.SLACK_WEBHOOK_URL_URGENT || null;
    this.adminDashboardBaseUrl = process.env.ADMIN_DASHBOARD_URL || 'https://free.spill.app/admin/dashboard';
    this.enabled = !!this.webhookUrl;

    if (this.enabled) {
      logger.info('Slack notification service initialized');
    } else {
      logger.info('Slack notifications disabled (SLACK_WEBHOOK_URL not set)');
    }
  }

  /**
   * Check if Slack notifications are enabled
   */
  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Queue a notification for retry (persisted to Redis)
   */
  private async queueForRetry(message: SlackMessage, useUrgentChannel: boolean): Promise<void> {
    // Also keep in memory for immediate retry attempts
    if (notificationQueue.length >= MAX_QUEUE_SIZE) {
      notificationQueue.shift();
      logger.warn('Slack notification in-memory queue full - dropping oldest item');
    }
    notificationQueue.push({
      message,
      useUrgentChannel,
      queuedAt: new Date(),
      attempts: 0,
    });

    // Persist to Redis for crash recovery
    try {
      const queueItem = {
        message,
        useUrgentChannel,
        queuedAt: new Date().toISOString(),
        attempts: 0,
      };

      // Get existing queue
      const existing = await cacheManager.getJson<typeof queueItem[]>(SLACK_QUEUE_KEY) || [];

      // Trim if too large
      while (existing.length >= MAX_QUEUE_SIZE) {
        existing.shift();
      }

      existing.push(queueItem);
      await cacheManager.setJson(SLACK_QUEUE_KEY, existing, SLACK_QUEUE_TTL);

      logger.info(
        { queueLength: existing.length, inMemoryLength: notificationQueue.length },
        'Slack notification queued for retry (persisted to Redis)'
      );
    } catch (err) {
      // Redis failure shouldn't prevent in-memory queue from working
      logger.warn({ err }, 'Failed to persist Slack notification to Redis - will retry from memory');
    }
  }

  /**
   * Load queued notifications from Redis on startup
   */
  async loadPersistedQueue(): Promise<number> {
    try {
      const persisted = await cacheManager.getJson<QueuedNotification[]>(SLACK_QUEUE_KEY);
      if (persisted && persisted.length > 0) {
        // Restore to in-memory queue
        for (const item of persisted) {
          if (notificationQueue.length < MAX_QUEUE_SIZE) {
            notificationQueue.push({
              ...item,
              queuedAt: new Date(item.queuedAt),
            });
          }
        }
        logger.info({ count: persisted.length }, 'Loaded persisted Slack notifications from Redis');
        return persisted.length;
      }
    } catch (err) {
      logger.warn({ err }, 'Failed to load persisted Slack notifications from Redis');
    }
    return 0;
  }

  /**
   * Process queued notifications (call periodically or on circuit close)
   */
  async processQueue(): Promise<{ processed: number; failed: number }> {
    if (notificationQueue.length === 0) {
      return { processed: 0, failed: 0 };
    }

    // Don't process if circuit is open
    if (slackCircuitBreaker.isOpen()) {
      logger.debug('Skipping queue processing - circuit is open');
      return { processed: 0, failed: 0 };
    }

    let processed = 0;
    let failed = 0;
    const maxRetries = 3;

    // Process up to 10 items per batch
    const batch = notificationQueue.splice(0, 10);

    for (const item of batch) {
      if (item.attempts >= maxRetries) {
        logger.warn(
          { attempts: item.attempts, message: item.message.text?.substring(0, 100) },
          'Dropping Slack notification after max retries'
        );
        failed++;
        continue;
      }

      try {
        const success = await this.sendToSlackDirect(item.message, item.useUrgentChannel);
        if (success) {
          processed++;
        } else {
          // Put back in queue with incremented attempts
          item.attempts++;
          notificationQueue.push(item);
          failed++;
        }
      } catch (err) {
        item.attempts++;
        notificationQueue.push(item);
        failed++;
      }
    }

    // Update Redis queue
    if (processed > 0 || failed > 0) {
      try {
        await cacheManager.setJson(SLACK_QUEUE_KEY, notificationQueue, SLACK_QUEUE_TTL);
      } catch (err) {
        // Non-fatal
        logger.warn({ err }, 'Failed to update Redis Slack queue');
      }
    }

    if (processed > 0 || failed > 0) {
      logger.info({ processed, failed, remaining: notificationQueue.length }, 'Processed Slack notification queue');
    }

    return { processed, failed };
  }

  /**
   * Get queue stats for monitoring
   */
  getQueueStats(): { inMemory: number; oldestAge?: number } {
    const oldest = notificationQueue[0];
    return {
      inMemory: notificationQueue.length,
      oldestAge: oldest ? Math.floor((Date.now() - oldest.queuedAt.getTime()) / 1000) : undefined,
    };
  }

  /**
   * Get circuit breaker stats for health checks
   */
  getCircuitStats() {
    return slackCircuitBreaker.getStats();
  }

  /**
   * Reset the circuit breaker to closed state (admin action)
   */
  resetCircuit(): void {
    slackCircuitBreaker.reset();
  }

  /**
   * Direct send without queuing (used by queue processor)
   */
  private async sendToSlackDirect(message: SlackMessage, useUrgentChannel: boolean): Promise<boolean> {
    const url = useUrgentChannel && this.webhookUrlUrgent
      ? this.webhookUrlUrgent
      : this.webhookUrl;

    if (!url) {
      return false;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), DEFAULT_TIMEOUTS.EXTERNAL_API);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(message),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);
      return response.ok;
    } catch (err) {
      clearTimeout(timeoutId);
      throw err;
    }
  }

  /**
   * Send a raw message to Slack (with circuit breaker protection)
   */
  private async sendToSlack(message: SlackMessage, useUrgentChannel: boolean = false): Promise<boolean> {
    const url = useUrgentChannel && this.webhookUrlUrgent
      ? this.webhookUrlUrgent
      : this.webhookUrl;

    if (!url) {
      logger.debug('Slack notification skipped - webhook URL not configured');
      return false;
    }

    try {
      // Use circuit breaker to protect against Slack outages
      const result = await slackCircuitBreaker.execute(async () => {
        // Create abort controller for timeout
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), DEFAULT_TIMEOUTS.EXTERNAL_API);

        try {
          const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(message),
            signal: controller.signal,
          });

          if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Slack API error: ${response.status} - ${errorText}`);
          }

          return true;
        } finally {
          clearTimeout(timeoutId);
        }
      });

      logger.debug('Slack notification sent successfully');
      return result;
    } catch (error) {
      // Handle circuit breaker open state - queue for retry
      if (error instanceof CircuitBreakerError) {
        logger.warn('Slack circuit open - queueing notification for retry');
        this.queueForRetry(message, useUrgentChannel);
        return false;
      }

      logger.error({ error }, 'Error sending Slack notification');
      // Queue for retry on other errors too
      this.queueForRetry(message, useUrgentChannel);
      return false;
    }
  }

  /**
   * Build appointment link for admin dashboard
   */
  private getAppointmentLink(appointmentId: string): string {
    return `${this.adminDashboardBaseUrl}/appointments/${appointmentId}`;
  }

  /**
   * Send a generic alert notification
   */
  async sendAlert(options: SlackAlertOptions): Promise<boolean> {
    const {
      title,
      severity,
      appointmentId,
      therapistName,
      details,
      additionalFields,
      emoji: customEmoji,
      fallbackSuffix,
    } = options;

    const emoji = customEmoji || SEVERITY_EMOJI[severity];
    const useUrgent = severity === 'critical' || severity === 'high';

    // Slack section text has a 3000-character limit.
    // Reserve space for the header line and therapist, then distribute the rest.
    const SLACK_SECTION_TEXT_LIMIT = 3000;
    const MAX_FIELD_VALUE_LENGTH = 200;

    // Build compact message with inline fields
    let messageText = details;

    // Add therapist inline if available (escaped for safety even though
    // therapist names are admin-set, as defense-in-depth).
    if (therapistName) {
      messageText += `\n*Therapist:* ${escapeSlackMrkdwn(therapistName)}`;
    }

    // Add additional fields inline, truncating long values to stay within Slack limits.
    // Cap the number of fields to keep the message scannable.
    const MAX_INLINE_FIELDS = 10;
    if (additionalFields && Object.keys(additionalFields).length > 0) {
      const entries = Object.entries(additionalFields);
      const shown = entries.slice(0, MAX_INLINE_FIELDS);
      for (const [key, value] of shown) {
        const truncated = value.length > MAX_FIELD_VALUE_LENGTH
          ? value.substring(0, MAX_FIELD_VALUE_LENGTH) + '...'
          : value;
        messageText += `\n*${escapeSlackMrkdwn(key)}:* ${escapeSlackMrkdwn(truncated)}`;
      }
      if (entries.length > MAX_INLINE_FIELDS) {
        messageText += `\n_…and ${entries.length - MAX_INLINE_FIELDS} more_`;
      }
    }

    // Final safety check: truncate at the last complete line boundary to avoid
    // slicing through a key-value pair, which would produce garbled mrkdwn.
    const headerLine = `${emoji} *${title}*\n`;
    const maxBodyLength = SLACK_SECTION_TEXT_LIMIT - headerLine.length;
    if (messageText.length > maxBodyLength) {
      const truncated = messageText.substring(0, maxBodyLength - 20);
      const lastNewline = truncated.lastIndexOf('\n');
      messageText = lastNewline > 0
        ? truncated.substring(0, lastNewline) + '\n_…message truncated_'
        : truncated + '…';
    }

    // Build compact blocks
    const blocks: SlackTextBlock[] = [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `${headerLine}${messageText}`,
        },
      },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: `${severity.toUpperCase()} | ${new Date().toLocaleString('en-GB', { timeZone: 'Europe/London' })} | ${appointmentId ? `<${this.getAppointmentLink(appointmentId)}|View> | ` : ''}<${this.adminDashboardBaseUrl}|Dashboard>`,
          },
        ],
      },
    ];

    // The `text` field is used by Slack as the fallback for push notifications
    // and email digests where Block Kit isn't rendered. Include the suffix so
    // key data (e.g. feedback scores) is visible even outside the Slack app.
    const fallbackText = `${emoji} ${title}: ${details}${fallbackSuffix || ''}`;

    const message: SlackMessage = {
      text: fallbackText.length > 3000 ? fallbackText.substring(0, 2997) + '...' : fallbackText,
      blocks,
      unfurl_links: false,
      unfurl_media: false,
    };

    return this.sendToSlack(message, useUrgent);
  }

  // ============================================
  // Specific Alert Types
  // ============================================

  /**
   * Alert when auto-escalation triggers (72h stall → human control)
   */
  async notifyAutoEscalation(
    appointmentId: string,
    userName: string | null,
    therapistName: string,
    stallDurationHours: number
  ): Promise<boolean> {
    return this.sendAlert({
      title: 'Auto-Escalation Triggered',
      severity: 'high',
      appointmentId,
      therapistName,
      details: `Conversation stalled for *${Math.round(stallDurationHours)}h*. Human control enabled.`,
    });
  }

  /**
   * Alert for thread divergence (crossed wires, CC issues)
   */
  async notifyThreadDivergence(
    appointmentId: string,
    userName: string | null,
    therapistName: string,
    divergenceType: string,
    description: string
  ): Promise<boolean> {
    return this.sendAlert({
      title: 'Thread Divergence',
      severity: 'high',
      appointmentId,
      therapistName,
      details: description,
      additionalFields: {
        'Type': divergenceType,
      },
    });
  }

  /**
   * Alert for email bounce
   */
  async notifyEmailBounce(
    appointmentId: string,
    userName: string | null,
    therapistName: string,
    bouncedEmail: string,
    bounceReason: string
  ): Promise<boolean> {
    return this.sendAlert({
      title: 'Email Bounce',
      severity: 'critical',
      appointmentId,
      therapistName,
      details: `Email to \`${bouncedEmail}\` bounced.`,
      additionalFields: {
        'Reason': bounceReason,
      },
    });
  }

  /**
   * Alert for conversation stall (activity but no progress)
   */
  async notifyConversationStall(
    appointmentId: string,
    userName: string | null,
    therapistName: string,
    stallDurationHours: number,
    lastToolFailure?: string
  ): Promise<boolean> {
    const additionalFields: Record<string, string> = {};
    if (lastToolFailure) {
      additionalFields['Last Failure'] = lastToolFailure;
    }

    return this.sendAlert({
      title: 'Conversation Stalled',
      severity: 'medium',
      appointmentId,
      therapistName,
      details: `No progress for *${Math.round(stallDurationHours)}h*.`,
      additionalFields: Object.keys(additionalFields).length > 0 ? additionalFields : undefined,
    });
  }

  /**
   * Alert when human review is flagged by the agent
   */
  async notifyHumanReviewFlagged(
    appointmentId: string,
    userName: string | null,
    therapistName: string,
    reason: string
  ): Promise<boolean> {
    return this.sendAlert({
      title: 'Human Review Requested',
      severity: 'high',
      appointmentId,
      therapistName,
      details: `AI flagged for review: ${reason}`,
    });
  }

  // ============================================
  // Appointment Lifecycle Notifications
  // ============================================

  /**
   * Notify when a new appointment is created
   */
  async notifyAppointmentCreated(
    appointmentId: string,
    userName: string | null,
    therapistName: string,
    userEmail: string
  ): Promise<boolean> {
    return this.sendAlert({
      title: 'Appointment Request',
      severity: 'low',
      appointmentId,
      therapistName,
      details: `New scheduling request created.`,
    });
  }

  /**
   * Notify when an appointment is confirmed
   */
  async notifyAppointmentConfirmed(
    appointmentId: string,
    userName: string | null,
    therapistName: string,
    confirmedDateTime: string
  ): Promise<boolean> {
    return this.sendAlert({
      title: 'Appointment Confirmed',
      severity: 'low',
      appointmentId,
      therapistName,
      details: `Booked for ${confirmedDateTime}.`,
      emoji: '🤝',
    });
  }

  /**
   * Notify when an appointment is cancelled
   */
  async notifyAppointmentCancelled(
    appointmentId: string,
    userName: string | null,
    therapistName: string,
    reason: string
  ): Promise<boolean> {
    return this.sendAlert({
      title: 'Appointment Cancelled',
      severity: 'medium',
      appointmentId,
      therapistName,
      details: `Reason: ${reason}`,
      emoji: '❌',
    });
  }

  /**
   * Notify when an appointment is completed (feedback received).
   *
   * Feedback answers are shown as an abridged inline summary beneath a
   * "Feedback" header. The full responses are always accessible via the
   * admin forms dashboard link.
   */
  async notifyAppointmentCompleted(
    appointmentId: string,
    userName: string | null,
    therapistName: string,
    feedbackSubmissionId?: string,
    feedbackData?: Record<string, string>
  ): Promise<boolean> {
    const formsUrl = this.adminDashboardBaseUrl.replace(/\/dashboard\/?$/, '/forms');

    let details = feedbackSubmissionId
      ? `Session completed, feedback received. <${formsUrl}|View Feedback>`
      : 'Session completed.';

    // Place therapist in the details block so it renders above the
    // feedback header — sendAlert would otherwise append it *after*
    // the "📋 Feedback:" line, making it look like a feedback answer.
    details += `\n*Therapist:* ${escapeSlackMrkdwn(therapistName)}`;

    const hasFeedback = feedbackData && Object.keys(feedbackData).length > 0;

    // Add a visual separator before feedback answers so they don't
    // blend into the appointment details line.
    if (hasFeedback) {
      details += '\n\n📋 *Feedback:*';
    }

    // Build a compact fallback that includes key feedback values so
    // push notifications and email digests are still informative.
    let fallbackSuffix = '';
    if (hasFeedback) {
      const summaryParts = Object.entries(feedbackData!)
        .slice(0, 4)
        .map(([k, v]) => {
          const shortKey = k.length > 25 ? k.slice(0, 22) + '...' : k;
          const shortVal = v.length > 30 ? v.slice(0, 27) + '...' : v;
          return `${shortKey}: ${shortVal}`;
        });
      fallbackSuffix = ` | ${summaryParts.join(' | ')}`;
    }

    // therapistName intentionally omitted — already embedded in details
    // above so it renders before the feedback section, not inside it.
    return this.sendAlert({
      title: 'Appointment Completed',
      severity: 'low',
      appointmentId,
      details,
      emoji: '✅',
      additionalFields: hasFeedback ? feedbackData : undefined,
      fallbackSuffix,
    });
  }

  /**
   * Alert when an incoming email could not be matched to any appointment
   * after max retries. This means a therapist or client reply was silently dropped.
   */
  async notifyUnmatchedEmailAbandoned(
    messageId: string,
    from: string,
    subject: string,
    attempts: number
  ): Promise<boolean> {
    return this.sendAlert({
      title: 'Unmatched Email Dropped',
      severity: 'high',
      details: `Incoming email could not be matched to any appointment after *${attempts}* attempts and was abandoned. Manual review needed.`,
      additionalFields: {
        'From': from,
        'Subject': subject.slice(0, 100),
        'Message ID': messageId,
      },
    });
  }

  // ============================================
  // Summary Reports
  // ============================================

  /**
   * Send a weekly summary of appointments (Monday 9am)
   */
  async sendWeeklySummary(stats: {
    totalActive: number;
    pending: number;
    contacted: number;
    negotiating: number;
    confirmed: number;
    stalled: number;
    needingAttention: number;
    completedThisWeek: number;
    cancelledThisWeek: number;
  }): Promise<boolean> {
    // Build compact summary text
    let summaryText = `📊 *Weekly Summary*\n`;
    summaryText += `Active: *${stats.totalActive}* | Completed: *${stats.completedThisWeek}* | Cancelled: *${stats.cancelledThisWeek}*\n`;
    summaryText += `Pending: ${stats.pending} | Contacted: ${stats.contacted} | Negotiating: ${stats.negotiating} | Confirmed: ${stats.confirmed}`;

    if (stats.stalled > 0 || stats.needingAttention > 0) {
      summaryText += `\n⚠️ *${stats.needingAttention} need attention* (${stats.stalled} stalled)`;
    }

    const blocks: SlackTextBlock[] = [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: summaryText,
        },
      },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: `${new Date().toLocaleString('en-GB', { timeZone: 'Europe/London' })} | <${this.adminDashboardBaseUrl}|Dashboard>`,
          },
        ],
      },
    ];

    return this.sendToSlack({
      text: `📊 Weekly Summary: ${stats.totalActive} active, ${stats.completedThisWeek} completed`,
      blocks,
    });
  }

  /**
   * Simple text notification (for quick alerts)
   */
  async sendSimpleMessage(text: string, urgent: boolean = false): Promise<boolean> {
    return this.sendToSlack({ text }, urgent);
  }
}

// Singleton instance
export const slackNotificationService = new SlackNotificationService();
