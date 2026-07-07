/**
 * Audit Event Service
 *
 * Provides append-only logging for appointment events, inspired by OpenClaw's
 * JSONL transcript pattern. Events are never modified, only appended, providing
 * full auditability and debuggability for scheduling conversations.
 *
 * This enables:
 * - Debugging failed conversations by replaying events
 * - Compliance/audit trail for healthcare scheduling
 * - Analytics on agent behavior patterns
 */

import { Prisma } from '@prisma/client';
import { prisma } from '../utils/database';
import { logger } from '../utils/logger';

/**
 * Event types for audit logging
 */
export type AuditEventType =
  | 'email_received'           // Incoming email from user or therapist
  | 'email_sent'               // Outgoing email sent by agent
  | 'tool_executed'            // Tool call completed (send_email, mark_complete, etc.)
  | 'tool_failed'              // Tool execution failed
  | 'claude_response'          // Claude API response received
  | 'status_change'            // Appointment status changed
  | 'human_control'            // Human control enabled/disabled
  | 'checkpoint_update'        // Conversation stage changed
  | 'facts_extracted'          // Conversation facts updated
  | 'error'                    // Error occurred during processing
  | 'stale_flagged'            // Appointment flagged as stale
  | 'follow_up_sent'           // Post-booking follow-up sent
  | 'session_held_unverified'  // Auto-transitioned to session_held with no verified meeting link
  | 'reschedule_overdue'       // Reschedule never finalised and the abandoned slot has passed
  // Lifecycle events (non-status-change). These are emitted by
  // recordAppointmentEvent and queried directly by event type.
  | 'chase_sent'
  | 'closure_recommended'
  | 'closure_dismissed'
  | 'closure_dismissed_auto'
  | 'admin_force_update';

/**
 * Actor types - who or what caused the event
 */
export type AuditActor =
  | 'agent'      // The AI agent
  | 'admin'      // Admin user via dashboard
  | 'user'       // The client/patient
  | 'therapist'  // The therapist
  | 'system';    // Automated system process (cron jobs, etc.)

/**
 * Base payload interface - all payloads extend this
 */
interface BasePayload {
  traceId?: string;
}

/**
 * Payload for email events
 */
export interface EmailEventPayload extends BasePayload {
  from: string;
  to: string;
  subject: string;
  bodyPreview?: string; // First 200 chars
  gmailMessageId?: string;
  classification?: string;
}

/**
 * Bucket field on tool-execution audit events. Distinguishes the cause
 * of each event so a post-incident triage can break down "51/50" into
 * the dominant failure mode without joining against logs. New values
 * cover the loop-level short-circuits (turn budget, same-hash guard)
 * which never reach the executor but still represent tool-use blocks
 * the model emitted.
 */
export type ToolEventBucket =
  | 'executed'
  | 'idempotent_skip'
  | 'human_control_skip'
  | 'lifecycle_ceiling_skip'
  | 'turn_budget_exhausted'
  | 'same_hash_blocked'
  | 'same_hash_aborted'
  | 'error';

/**
 * Payload for tool execution events
 */
export interface ToolEventPayload extends BasePayload {
  toolName: string;
  input?: Record<string, unknown>;
  result?: 'success' | 'failed' | 'skipped';
  skipReason?: string;
  error?: string;
  bucket?: ToolEventBucket;
}

/**
 * Payload for status change events
 */
export interface StatusChangePayload extends BasePayload {
  previousStatus: string;
  newStatus: string;
  reason?: string;
}

/**
 * Payload for human control events
 */
export interface HumanControlPayload extends BasePayload {
  enabled: boolean;
  adminEmail?: string;
  reason?: string;
}

/**
 * Payload for checkpoint/stage updates
 */
export interface CheckpointPayload extends BasePayload {
  previousStage?: string;
  newStage: string;
  action?: string;
}

/**
 * Payload for appointment lifecycle events emitted via recordAppointmentEvent.
 * Looser than CheckpointPayload — chase_sent and closure_recommended events
 * don't represent stage transitions and have no newStage.
 */
export interface AppointmentEventPayload extends BasePayload {
  action: string;
  reason?: string;
  previousStage?: string;
  newStage?: string;
  // Free-form per-event context (e.g. chasedParty, inactiveHours, adminId)
  [key: string]: unknown;
}

/**
 * Payload for facts extraction events
 */
export interface FactsPayload extends BasePayload {
  facts: {
    proposedTimes?: string[];
    selectedTime?: string;
    confirmedTime?: string;
    therapistPreferences?: string[];
    userPreferences?: string[];
    blockers?: string[];
  };
}

/**
 * Payload for error events
 */
export interface ErrorPayload extends BasePayload {
  errorType: string;
  errorMessage: string;
  stack?: string;
  context?: Record<string, unknown>;
}

/**
 * Payload for Claude response events
 */
export interface ClaudeResponsePayload extends BasePayload {
  model: string;
  stopReason: string;
  inputTokens?: number;
  outputTokens?: number;
  toolsRequested?: string[];
  responsePreview?: string; // First 200 chars
}

/**
 * Payload for follow-up sent events (post-booking follow-ups)
 */
export interface FollowUpPayload extends BasePayload {
  followUpType: 'meeting_link_check' | 'feedback_form' | 'feedback_reminder' | 'session_reminder';
}

/**
 * Payload for stale/flagged events
 */
export interface StaleFlaggedPayload extends BasePayload {
  reason: string;
}

/**
 * Payload for a session_held transition the system made without positive
 * evidence a meeting link exists (meetingLinkConfirmedAt was null at tick
 * time). Records HOW the session time was known so triage can tell a
 * never-set-up booking from a normal one whose link simply arrived
 * out-of-band.
 */
export interface SessionHeldUnverifiedPayload extends BasePayload {
  confirmedDateTime?: string | null;
  note: string;
}

/**
 * Union type for all payloads
 */
export type AuditEventPayload =
  | EmailEventPayload
  | ToolEventPayload
  | StatusChangePayload
  | HumanControlPayload
  | CheckpointPayload
  | AppointmentEventPayload
  | FactsPayload
  | ErrorPayload
  | ClaudeResponsePayload
  | FollowUpPayload
  | StaleFlaggedPayload
  | SessionHeldUnverifiedPayload
  | BasePayload;

/**
 * Audit Event Service class
 */
class AuditEventService {
  /**
   * Log an audit event (fire-and-forget, doesn't block on errors)
   */
  async log(
    appointmentRequestId: string,
    eventType: AuditEventType,
    actor: AuditActor,
    payload?: AuditEventPayload
  ): Promise<void> {
    try {
      await prisma.appointmentAuditEvent.create({
        data: {
          appointmentRequestId,
          eventType,
          actor,
          // Prisma's nullable JSON column needs the sentinel `Prisma.JsonNull`
          // (DB NULL) or `Prisma.DbNull` to distinguish from JSON's `null`.
          // Plain JS null gets rejected by the type checker.
          payload: payload ? (payload as Prisma.InputJsonValue) : Prisma.JsonNull,
        },
      });

      logger.debug(
        { appointmentRequestId, eventType, actor },
        'Audit event logged'
      );
    } catch (error) {
      // Log error but don't throw - audit logging should never break main flow
      logger.error(
        { error, appointmentRequestId, eventType, actor },
        'Failed to log audit event'
      );
    }
  }

  /**
   * Log email received event
   */
  async logEmailReceived(
    appointmentRequestId: string,
    actor: 'user' | 'therapist',
    payload: EmailEventPayload
  ): Promise<void> {
    await this.log(appointmentRequestId, 'email_received', actor, {
      ...payload,
      bodyPreview: payload.bodyPreview?.slice(0, 200),
    });
  }

  /**
   * Log email sent event
   */
  async logEmailSent(
    appointmentRequestId: string,
    payload: EmailEventPayload
  ): Promise<void> {
    await this.log(appointmentRequestId, 'email_sent', 'agent', {
      ...payload,
      bodyPreview: payload.bodyPreview?.slice(0, 200),
    });
  }

  /**
   * Log tool execution event
   */
  async logToolExecuted(
    appointmentRequestId: string,
    payload: ToolEventPayload
  ): Promise<void> {
    await this.log(appointmentRequestId, 'tool_executed', 'agent', payload);
  }

  /**
   * Log tool failure event
   */
  async logToolFailed(
    appointmentRequestId: string,
    payload: ToolEventPayload
  ): Promise<void> {
    await this.log(appointmentRequestId, 'tool_failed', 'agent', payload);
  }

  /**
   * Log status change event
   */
  async logStatusChange(
    appointmentRequestId: string,
    actor: AuditActor,
    payload: StatusChangePayload
  ): Promise<void> {
    await this.log(appointmentRequestId, 'status_change', actor, payload);
  }

  /**
   * Log human control event
   */
  async logHumanControl(
    appointmentRequestId: string,
    payload: HumanControlPayload
  ): Promise<void> {
    await this.log(appointmentRequestId, 'human_control', 'admin', payload);
  }

  /**
   * Log checkpoint/stage update event
   */
  async logCheckpointUpdate(
    appointmentRequestId: string,
    payload: CheckpointPayload
  ): Promise<void> {
    await this.log(appointmentRequestId, 'checkpoint_update', 'agent', payload);
  }

  /**
   * Log facts extraction event
   */
  async logFactsExtracted(
    appointmentRequestId: string,
    payload: FactsPayload
  ): Promise<void> {
    await this.log(appointmentRequestId, 'facts_extracted', 'agent', payload);
  }

  /**
   * Log error event
   */
  async logError(
    appointmentRequestId: string,
    payload: ErrorPayload
  ): Promise<void> {
    await this.log(appointmentRequestId, 'error', 'system', payload);
  }

  /**
   * Log Claude response event
   */
  async logClaudeResponse(
    appointmentRequestId: string,
    payload: ClaudeResponsePayload
  ): Promise<void> {
    await this.log(appointmentRequestId, 'claude_response', 'agent', payload);
  }

  /**
   * Get all events for an appointment (for debugging/replay)
   */
  async getEvents(
    appointmentRequestId: string,
    options?: {
      eventTypes?: AuditEventType[];
      limit?: number;
      since?: Date;
    }
  ): Promise<Array<{
    id: string;
    eventType: string;
    actor: string;
    payload: unknown;
    createdAt: Date;
  }>> {
    const where: Record<string, unknown> = { appointmentRequestId };

    if (options?.eventTypes?.length) {
      where.eventType = { in: options.eventTypes };
    }

    if (options?.since) {
      where.createdAt = { gte: options.since };
    }

    return prisma.appointmentAuditEvent.findMany({
      where,
      orderBy: { createdAt: 'asc' },
      take: options?.limit ?? 1000,
    });
  }

  /**
   * Get event count summary for an appointment
   */
  async getEventSummary(appointmentRequestId: string): Promise<Record<string, number>> {
    const events = await prisma.appointmentAuditEvent.groupBy({
      by: ['eventType'],
      where: { appointmentRequestId },
      _count: true,
    });

    return events.reduce((acc, e) => {
      acc[e.eventType] = e._count;
      return acc;
    }, {} as Record<string, number>);
  }
}

// Export singleton instance
export const auditEventService = new AuditEventService();
