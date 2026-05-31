/**
 * Scheduling Context Service
 *
 * Extracted from justin-time.service.ts — owns the shared type definitions
 * (SchedulingContext, ToolExecutionResult, ConversationMessage) and provides
 * helpers for building scheduling context objects from database records.
 *
 * These types are consumed by:
 *   - justin-time.service.ts (orchestrator)
 *   - ai-tool-executor.service.ts (tool dispatch)
 *   - agent-tool-loop.ts (tool loop)
 *   - system-prompt-builder.ts (prompt construction)
 *   - ai-conversation.service.ts (conversation state)
 */

import { Prisma } from '@prisma/client';
import { prisma } from '../utils/database';
import { logger } from '../utils/logger';
import { firstName } from '../utils/first-name';
import type { ConversationAction } from '../services/conversation-checkpoint.service';
import type { SendEmailPurpose } from '../schemas/tool-inputs';

/**
 * FIX T1: Tool execution result type for explicit success/failure reporting
 * Instead of returning void, executeToolCall now returns this type so callers
 * can verify the tool actually succeeded and update appointment status accordingly.
 *
 * FIX RSA-1: Added checkpointAction to enable checkpoint updates after tool execution
 */
export interface ToolExecutionResult {
  success: boolean;
  toolName: string;
  error?: string;
  skipped?: boolean;
  // 'human_control'        — admin has taken over (both agents)
  // 'idempotent'           — same tool call already executed within TTL (both agents)
  // 'conversation_inactive'— the parent entity (TherapistConversation) is no longer
  //                          'active' (completed / superseded / abandoned). Only set
  //                          by the availability-collection executor; the booking
  //                          executor never returns this because the equivalent
  //                          condition (cancelled appointment) is gated upstream.
  skipReason?: 'human_control' | 'idempotent' | 'conversation_inactive';
  /** Action to record in checkpoint after successful execution */
  checkpointAction?: ConversationAction;
  /** Who the email was sent to (for checkpoint context) */
  emailSentTo?: 'user' | 'therapist';
  /**
   * Declared purpose for a send_email call (when the agent passes one
   * — backwards-compatible: omitted on calls that don't set it). Used
   * by the agent loop to:
   *   - exempt `request_more_availability` from the wouldRegress guard
   *     (the regression is the declared intent, not an accident);
   *   - skip the checkpoint update entirely for `acknowledge` (courtesy
   *     reply — no party-pending change, so no stage change).
   * Stays undefined for non-send_email tools. Sourced from
   * schemas/tool-inputs so adding a purpose to the schema propagates
   * here automatically.
   */
  emailPurpose?: SendEmailPurpose;
  /** Custom result data to return to Claude (JSON-serialized). If set, used instead of generic success message. */
  resultMessage?: string;
  /** Response tracking data to merge into conversation state (avoids mid-loop state save conflicts) */
  responseTracking?: { lastEmailSentToTherapist: string; pendingSince: string };
  /**
   * Suppress the dispatch orchestrator's post-success bookkeeping
   * (Redis idempotency mark, per-appointment lifetime-ceiling
   * increment, `bucket: 'executed'` audit event).
   *
   * Set by tools that are "informational" — they may run repeatedly
   * with the same input (e.g. the agent adds another `remember`
   * note, records another availability window, persists a corrected
   * timezone) and have their own at-the-storage-layer dedup, so the
   * outer Redis idempotency mark is unhelpful and the ceiling
   * increment would otherwise push working appointments into human-
   * control prematurely.
   *
   * Preserves the pre-Phase-2c behaviour exactly: in the original
   * monolithic executor those six tools (`issue_voucher_code`,
   * `remember`, `record_availability_window`, `record_booking_link`,
   * `record_user_timezone`, `record_therapist_timezone`) early-
   * returned from the dispatch switch, bypassing the post-switch
   * bookkeeping block. The refactor surfaces that asymmetry
   * explicitly via this flag rather than relying on switch-statement
   * control flow.
   */
  bypassPostSuccessBookkeeping?: boolean;
}

export type BookingMethod = 'agent_negotiated' | 'direct_link';

export interface SchedulingContext {
  appointmentRequestId: string;
  userName: string;
  userEmail: string;
  therapistEmail: string;
  therapistName: string;
  therapistAvailability: Record<string, unknown> | null;
  /** How the booking was initiated: agent negotiation (default) or direct booking link */
  bookingMethod: BookingMethod;
  /** Country code where the user is based (e.g. "UK", "US"). Defaults to "UK". */
  userCountry: string;
  /** Country code where the therapist is based. Defaults to "UK". */
  therapistCountry: string;
  /**
   * Explicit IANA timezone the booking agent has recorded for the user
   * via `record_user_timezone`. Optional — null for users in single-zone
   * countries (the resolver falls back to the country default) or
   * multi-zone users we haven't yet asked.
   */
  userTimezone?: string;
  /**
   * Explicit IANA timezone for the therapist (from `Therapist.timezone`,
   * populated by either agent via `record_therapist_timezone`).
   * Optional — same fallback chain applies when absent.
   */
  therapistTimezone?: string;
  /**
   * Which party sent the inbound email that triggered this tool loop.
   * Undefined for startScheduling (no inbound — kicked off by the booking
   * form). Used to gate sender-attributable tools like
   * update_therapist_availability so a user cannot prompt-inject a
   * schedule overwrite.
   */
  inboundSender?: 'user' | 'therapist';
  /**
   * Primary keys of the User / Therapist rows linked to this appointment.
   * Optional because legacy appointment rows pre-date the User/Therapist
   * entities and may have null userId/therapistId. The system prompt
   * builder uses these to look up cross-appointment profile notes
   * (Layer C); when absent, no profile section renders.
   *
   * Reads against User.agentNotes / Therapist.agentNotes MUST go through
   * these primary keys — never via email or any other identifier — so the
   * cross-thread isolation contract holds.
   */
  userId?: string;
  therapistId?: string;
}

export interface ConversationMessage {
  role: 'user' | 'assistant' | 'admin';
  content: string;
}

/**
 * Build a SchedulingContext from a database appointment request record.
 *
 * This centralises the mapping so callers don't have to repeat it.
 * The record parameter accepts the shape returned by a typical
 * prisma.appointmentRequest.findUnique() call.
 *
 * `user` and `therapist` may be passed when callers have already loaded the
 * related records — we use their `country` to drive timezone handling.
 * Both default to 'UK' when missing.
 */
export function buildSchedulingContext(
  appointmentRequest: {
    id: string;
    userName: string | null;
    userEmail: string;
    userId?: string | null;
    therapistEmail: string;
    therapistName: string;
    therapistId?: string | null;
    therapistAvailability: unknown;
    bookingMethod?: string;
    user?: { country: string; timezone?: string | null } | null;
    therapist?: { country: string; timezone?: string | null } | null;
  },
): SchedulingContext {
  return {
    appointmentRequestId: appointmentRequest.id,
    // Names flow into AI prompts and email salutations — first-name only,
    // see utils/first-name.ts. Centralising the trim here means the AI's
    // tool calls render "Hi John," not "Hi John Smith,".
    userName: firstName(appointmentRequest.userName),
    userEmail: appointmentRequest.userEmail,
    userId: appointmentRequest.userId ?? undefined,
    therapistEmail: appointmentRequest.therapistEmail,
    therapistName: firstName(appointmentRequest.therapistName),
    therapistId: appointmentRequest.therapistId ?? undefined,
    therapistAvailability: appointmentRequest.therapistAvailability as Record<string, unknown> | null,
    bookingMethod: (appointmentRequest.bookingMethod as BookingMethod) || 'agent_negotiated',
    userCountry: appointmentRequest.user?.country || 'UK',
    therapistCountry: appointmentRequest.therapist?.country || 'UK',
    userTimezone: appointmentRequest.user?.timezone ?? undefined,
    therapistTimezone: appointmentRequest.therapist?.timezone ?? undefined,
  };
}

/**
 * The relation `include` shape that {@link buildSchedulingContext} depends
 * on: each party's `country` (drives the timezone fallback chain) AND their
 * explicit `timezone` (persisted by `record_user_timezone` /
 * `record_therapist_timezone`).
 *
 * Exported and shared so EVERY caller that loads an appointment row to build
 * a SchedulingContext fetches the same columns. `processEmailReply` used to
 * hand-roll an `include` that selected `country` only, which silently dropped
 * the recorded timezone from the email-reply prompt — the timezone section
 * then rendered "unknown — you MUST ask" on every turn even after the agent
 * had already recorded the zone, defeating those tools. Centralising the
 * shape here makes that drift impossible.
 */
export const SCHEDULING_CONTEXT_RELATIONS_INCLUDE = {
  user: { select: { country: true, timezone: true } },
  therapist: { select: { country: true, timezone: true } },
} satisfies Prisma.AppointmentRequestInclude;

/**
 * Fetch an appointment request from the database and build a SchedulingContext.
 * Returns null if the appointment is not found.
 */
export async function fetchSchedulingContext(
  appointmentRequestId: string,
  traceId?: string,
): Promise<SchedulingContext | null> {
  const appointmentRequest = await prisma.appointmentRequest.findUnique({
    where: { id: appointmentRequestId },
    include: SCHEDULING_CONTEXT_RELATIONS_INCLUDE,
  });

  if (!appointmentRequest) {
    logger.warn(
      { traceId, appointmentRequestId },
      'Appointment request not found when building scheduling context',
    );
    return null;
  }

  return buildSchedulingContext(appointmentRequest);
}
