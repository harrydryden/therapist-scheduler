/**
 * Centralised emitter for appointment lifecycle events that aren't status
 * transitions (chase sent, closure recommended, closure dismissed,
 * closure auto-dismissed, admin force update). Each event always writes
 * an audit log entry and optionally fires a Slack alert.
 *
 * transition-side-effects.service.ts handles status-change side effects
 * (therapist freeze/unfreeze, SSE broadcast) — that's the parallel
 * concept keyed off `status` rather than checkpoint events.
 */

import { auditEventService, type AuditActor, type AppointmentEventPayload } from './audit-event.service';
import { slackNotificationService } from './slack-notification.service';
import { sseService } from './sse.service';
import { logger } from '../utils/logger';
import type { AlertSeverity } from './slack-notification.service';

/**
 * The closed set of non-status-change lifecycle events. Adding to this
 * union forces the dispatch table in `recordAppointmentEvent` to be
 * updated, which is the point.
 */
export type AppointmentEventType =
  | 'chase_sent'
  | 'closure_recommended'
  | 'closure_dismissed'
  | 'closure_dismissed_auto'
  | 'admin_force_update';

export interface AppointmentEvent {
  appointmentId: string;
  type: AppointmentEventType;
  actor: AuditActor;
  /** Free-form reason persisted to the audit payload. */
  reason?: string;
  /** Extra payload merged into the audit event for type-specific context. */
  payload?: Record<string, unknown>;
  /** Optional Slack alert. Omit to skip the notification. */
  slack?: {
    title: string;
    severity: AlertSeverity;
    details: string;
    additionalFields?: Record<string, string>;
  };
}

/**
 * Tell connected admin dashboards that something happened on an
 * appointment that isn't a status change (a new message, a chase, an admin
 * email), so an open detail drawer refetches instead of going stale.
 * Emits `appointment:activity` on the SSE bus; never throws.
 */
export function notifyAppointmentActivity(appointmentId: string, activityType: string): void {
  try {
    sseService.emitActivity(appointmentId, activityType);
  } catch (err) {
    logger.warn({ err, appointmentId, activityType }, 'Failed to emit appointment activity event');
  }
}

/**
 * Record an appointment lifecycle event. Always writes an audit log entry;
 * optionally fires a Slack alert (fire-and-forget — the caller never blocks
 * on Slack delivery).
 *
 * The audit row's `eventType` matches `event.type` directly so a query like
 * "show me all closure recommendations for this appointment" hits the right
 * rows without unwrapping a generic `checkpoint_update` payload.
 */
export async function recordAppointmentEvent(event: AppointmentEvent): Promise<void> {
  // Audit log is the durable record. auditEventService.log catches and logs
  // internally, so the await never throws — but we still await so the audit
  // entry lands before the (fire-and-forget) Slack call below.
  const payload: AppointmentEventPayload = {
    action: event.type,
    ...(event.reason ? { reason: event.reason } : {}),
    ...event.payload,
  };
  await auditEventService.log(
    event.appointmentId,
    event.type,
    event.actor,
    payload,
  );

  // Live dashboards: the event changed what the detail drawer shows.
  notifyAppointmentActivity(event.appointmentId, event.type);

  // Slack is fire-and-forget. We never block the caller on Slack delivery
  // and we never propagate Slack failures back as an exception.
  if (event.slack) {
    slackNotificationService.sendAlert({
      title: event.slack.title,
      severity: event.slack.severity,
      appointmentId: event.appointmentId,
      details: event.slack.details,
      additionalFields: event.slack.additionalFields,
    }).catch((err) => {
      logger.warn(
        { err, appointmentId: event.appointmentId, type: event.type },
        'Failed to send Slack alert for appointment event'
      );
    });
  }
}
