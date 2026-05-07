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

import { prisma } from '../utils/database';
import { logger } from '../utils/logger';
import { firstName } from '../utils/first-name';
import type { ConversationAction } from '../services/conversation-checkpoint.service';

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
  skipReason?: 'human_control' | 'idempotent';
  /** Action to record in checkpoint after successful execution */
  checkpointAction?: ConversationAction;
  /** Who the email was sent to (for checkpoint context) */
  emailSentTo?: 'user' | 'therapist';
  /** Custom result data to return to Claude (JSON-serialized). If set, used instead of generic success message. */
  resultMessage?: string;
  /** Response tracking data to merge into conversation state (avoids mid-loop state save conflicts) */
  responseTracking?: { lastEmailSentToTherapist: string; pendingSince: string };
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
    therapistEmail: string;
    therapistName: string;
    therapistAvailability: unknown;
    bookingMethod?: string;
    user?: { country: string } | null;
    therapist?: { country: string } | null;
  },
): SchedulingContext {
  return {
    appointmentRequestId: appointmentRequest.id,
    // Names flow into AI prompts and email salutations — first-name only,
    // see utils/first-name.ts. Centralising the trim here means the AI's
    // tool calls render "Hi John," not "Hi John Smith,".
    userName: firstName(appointmentRequest.userName),
    userEmail: appointmentRequest.userEmail,
    therapistEmail: appointmentRequest.therapistEmail,
    therapistName: firstName(appointmentRequest.therapistName),
    therapistAvailability: appointmentRequest.therapistAvailability as Record<string, unknown> | null,
    bookingMethod: (appointmentRequest.bookingMethod as BookingMethod) || 'agent_negotiated',
    userCountry: appointmentRequest.user?.country || 'UK',
    therapistCountry: appointmentRequest.therapist?.country || 'UK',
  };
}

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
    include: {
      user: { select: { country: true } },
      therapist: { select: { country: true } },
    },
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
