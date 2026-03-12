/**
 * AI Tool Executor Service
 *
 * Extracted from justin-time.service.ts — handles all tool execution dispatch
 * and side effects triggered by Claude's tool calls during scheduling conversations.
 *
 * Responsibilities:
 *   - Tool input validation (Zod schemas)
 *   - Tool call dispatch (switch on tool name)
 *   - Idempotency checking (Redis-based deduplication)
 *   - Side effects: email sending, availability updates, appointment
 *     confirmation/cancellation, human review flagging, match cancellation
 *   - Email body normalization and threading
 *   - Audit logging for tool executions
 */

import { z } from 'zod';
import crypto from 'crypto';
import Anthropic from '@anthropic-ai/sdk';
import { logger } from '../utils/logger';
import { prisma } from '../utils/database';
import { emailProcessingService } from './email-processing.service';
import { notionService } from './notion.service';
import { auditEventService } from './audit-event.service';
import { slackNotificationService } from './slack-notification.service';
import { appointmentLifecycleService } from './appointment-lifecycle.service';
import { APPOINTMENT_STATUS, EMAIL } from '../constants';
import type { AppointmentStatus } from '../constants';
import { prependTrackingCodeToSubject } from '../utils/tracking-code';
import { emailQueueService } from './email-queue.service';
import { redis } from '../utils/redis';
import type { ConversationAction } from '../utils/conversation-checkpoint';
import type { SchedulingContext, ToolExecutionResult } from './justin-time.service';
import { availabilityResolver } from './availability-resolver.service';

// ─── Tool Input Validation Schemas ────────────────────────────────────────────

const sendEmailInputSchema = z.object({
  to: z.string().email(),
  subject: z.string().min(1).max(1000),
  body: z.string().min(1).max(50000),
});

const updateAvailabilityInputSchema = z.object({
  availability: z.record(z.string(), z.string()),
});

const markCompleteInputSchema = z.object({
  confirmed_datetime: z.string().min(1),
  notes: z.string().optional(),
});

const cancelAppointmentInputSchema = z.object({
  reason: z.string().min(1).max(500),
  cancelled_by: z.enum(['client', 'therapist']),
});

const recommendCancelMatchInputSchema = z.object({
  reason: z.string().min(1).max(500),
});

// ─── Idempotency Helpers ──────────────────────────────────────────────────────

const TOOL_EXECUTION_PREFIX = 'tool:executed:';
const TOOL_EXECUTION_TTL_SECONDS = 3600; // 1 hour - enough to cover retries

/**
 * Generate a deterministic hash for a tool call to enable idempotency checking
 */
function hashToolCall(appointmentId: string, toolName: string, input: unknown): string {
  const data = JSON.stringify({ appointmentId, toolName, input });
  return crypto.createHash('sha256').update(data).digest('hex').substring(0, 32);
}

/**
 * Check if a tool call was already executed (for idempotency)
 * Returns true if already executed, false if new
 */
async function wasToolExecuted(hash: string): Promise<boolean> {
  try {
    const result = await redis.get(`${TOOL_EXECUTION_PREFIX}${hash}`);
    return result !== null;
  } catch (err) {
    // Redis unavailable - allow execution but log warning
    logger.warn({ err, hash }, 'Redis unavailable for idempotency check - allowing execution');
    return false;
  }
}

/**
 * Mark a tool call as executed (for idempotency)
 */
async function markToolExecuted(hash: string, traceId: string): Promise<void> {
  try {
    await redis.set(
      `${TOOL_EXECUTION_PREFIX}${hash}`,
      traceId,
      'EX',
      TOOL_EXECUTION_TTL_SECONDS
    );
  } catch (err) {
    // Redis unavailable - log warning but don't fail
    logger.warn({ err, hash, traceId }, 'Failed to mark tool as executed - idempotency may not work');
  }
}

// ─── AI Tool Executor Service ─────────────────────────────────────────────────

export class AIToolExecutorService {
  private traceId: string;

  constructor(traceId?: string) {
    this.traceId = traceId || 'ai-tool-executor';
  }

  /**
   * Execute a tool call from Claude
   * FIX J1/J2: Added idempotency checking to prevent duplicate tool executions
   * FIX T1: Now returns ToolExecutionResult for explicit success/failure reporting
   * FIX H1: Uses atomic updateMany to prevent race condition with human control
   */
  async executeToolCall(
    toolCall: Anthropic.ToolUseBlock,
    context: SchedulingContext
  ): Promise<ToolExecutionResult> {
    const { name, input } = toolCall;

    // FIX H1: Use atomic updateMany to prevent race condition
    // Instead of: read humanControlEnabled → check → execute (TOCTOU vulnerability)
    // Now: atomic update that only succeeds if humanControlEnabled is false
    // This prevents tool execution if human control was enabled between check and execution
    const lockResult = await prisma.appointmentRequest.updateMany({
      where: {
        id: context.appointmentRequestId,
        humanControlEnabled: false, // Only proceed if NOT under human control
      },
      data: {
        lastToolExecutedAt: new Date(),
      },
    });

    if (lockResult.count === 0) {
      // Either human control was enabled or appointment doesn't exist
      logger.info(
        { traceId: this.traceId, tool: name, appointmentRequestId: context.appointmentRequestId },
        'Skipping tool execution - human control enabled or appointment not found'
      );

      // Audit log: skipped due to human control
      auditEventService.logToolExecuted(context.appointmentRequestId, {
        traceId: this.traceId,
        toolName: name,
        result: 'skipped',
        skipReason: 'human_control',
      });

      return { success: true, toolName: name, skipped: true, skipReason: 'human_control' };
    }

    // FIX J1/J2: Check idempotency before executing
    // This prevents duplicate emails, double-confirmations, etc. on retries
    const toolHash = hashToolCall(context.appointmentRequestId, name, input);
    const alreadyExecuted = await wasToolExecuted(toolHash);

    if (alreadyExecuted) {
      logger.info(
        { traceId: this.traceId, tool: name, appointmentRequestId: context.appointmentRequestId, toolHash },
        'Skipping tool execution - already executed (idempotent)'
      );

      // Audit log: skipped due to idempotency
      auditEventService.logToolExecuted(context.appointmentRequestId, {
        traceId: this.traceId,
        toolName: name,
        result: 'skipped',
        skipReason: 'idempotent',
      });

      return { success: true, toolName: name, skipped: true, skipReason: 'idempotent' };
    }

    logger.info({ traceId: this.traceId, tool: name, input }, 'Executing tool call');

    // FIX RSA-1: Track checkpoint action and email target for state updates
    let checkpointAction: ConversationAction | undefined;
    let emailSentTo: 'user' | 'therapist' | undefined;

    try {
      switch (name) {
        case 'send_email': {
          const parsed = sendEmailInputSchema.safeParse(input);
          if (!parsed.success) {
            const errorMsg = `Invalid send_email input: ${parsed.error.message}`;
            logger.error({ traceId: this.traceId, errors: parsed.error.errors }, 'Invalid send_email input');
            return { success: false, toolName: name, error: errorMsg };
          }
          const emailData = parsed.data;

          // SECURITY: Validate that the recipient is either the user or therapist
          // This prevents the agent from hallucinating email addresses or sending to arbitrary recipients
          const normalizedTo = emailData.to.toLowerCase().trim();
          const allowedRecipients = [
            context.userEmail.toLowerCase().trim(),
            context.therapistEmail.toLowerCase().trim(),
          ].filter(e => e); // Filter out empty strings

          if (!allowedRecipients.includes(normalizedTo)) {
            const errorMsg = `Invalid recipient: "${emailData.to}" is not a recognized email for this appointment. ` +
              `Allowed recipients are: ${context.userEmail} (client) or ${context.therapistEmail} (therapist). ` +
              `Please use the exact email address provided in the context.`;
            logger.error(
              {
                traceId: this.traceId,
                attemptedRecipient: emailData.to,
                allowedRecipients,
                appointmentRequestId: context.appointmentRequestId,
              },
              'Agent attempted to send email to unauthorized recipient'
            );
            return { success: false, toolName: name, error: errorMsg };
          }

          await this.sendEmail(
            { to: emailData.to, subject: emailData.subject, body: emailData.body },
            context.appointmentRequestId
          );
          // FIX RSA-1: Determine checkpoint action based on recipient
          emailSentTo = normalizedTo === context.therapistEmail.toLowerCase() ? 'therapist' : 'user';
          // Set checkpoint action based on recipient so the conversation stage
          // is properly tracked. Without this, the checkpoint is never initialized
          // after startScheduling (only send_email is called), leaving the stage
          // as undefined and breaking stage-aware recovery and prompt guidance.
          checkpointAction = emailSentTo === 'therapist'
            ? 'sent_initial_email_to_therapist'
            : 'sent_availability_to_user';
          break;
        }

        case 'update_therapist_availability': {
          const parsed = updateAvailabilityInputSchema.safeParse(input);
          if (!parsed.success) {
            const errorMsg = `Invalid update_therapist_availability input: ${parsed.error.message}`;
            logger.error({ traceId: this.traceId, errors: parsed.error.errors }, 'Invalid update_therapist_availability input');
            return { success: false, toolName: name, error: errorMsg };
          }
          const availData = parsed.data;
          await this.updateTherapistAvailability(context, { availability: availData.availability });
          checkpointAction = 'received_therapist_availability';
          break;
        }

        case 'mark_scheduling_complete': {
          const parsed = markCompleteInputSchema.safeParse(input);
          if (!parsed.success) {
            const errorMsg = `Invalid mark_scheduling_complete input: ${parsed.error.message}`;
            logger.error({ traceId: this.traceId, errors: parsed.error.errors }, 'Invalid mark_scheduling_complete input');
            return { success: false, toolName: name, error: errorMsg };
          }
          const completeData = parsed.data;

          // FIX RSA-2: Validate that confirmed_datetime contains a parseable date/time
          // Either party (user or therapist) can confirm, but a datetime must be provided
          const validationError = availabilityResolver.validateMarkComplete(completeData.confirmed_datetime);
          if (validationError) {
            logger.warn(
              { traceId: this.traceId, confirmedDateTime: completeData.confirmed_datetime, error: validationError },
              'mark_scheduling_complete validation failed'
            );
            return { success: false, toolName: name, error: validationError };
          }

          await this.markComplete(context, { confirmed_datetime: completeData.confirmed_datetime, notes: completeData.notes });
          checkpointAction = 'sent_final_confirmations';
          break;
        }

        case 'cancel_appointment': {
          const parsed = cancelAppointmentInputSchema.safeParse(input);
          if (!parsed.success) {
            const errorMsg = `Invalid cancel_appointment input: ${parsed.error.message}`;
            logger.error({ traceId: this.traceId, errors: parsed.error.errors }, 'Invalid cancel_appointment input');
            return { success: false, toolName: name, error: errorMsg };
          }
          const cancelData = parsed.data;
          await this.cancelAppointment(context, {
            reason: cancelData.reason,
            cancelled_by: cancelData.cancelled_by,
          });
          checkpointAction = 'processed_cancellation';
          break;
        }

        case 'recommend_cancel_match': {
          const parsed = recommendCancelMatchInputSchema.safeParse(input);
          if (!parsed.success) {
            const errorMsg = `Invalid recommend_cancel_match input: ${parsed.error.message}`;
            logger.error({ traceId: this.traceId, errors: parsed.error.errors }, 'Invalid recommend_cancel_match input');
            return { success: false, toolName: name, error: errorMsg };
          }
          await this.recommendCancelMatch(context, parsed.data.reason);
          checkpointAction = 'recommended_cancel_match';
          break;
        }

        case 'flag_for_human_review': {
          const flagInput = input as { reason: string; suggested_action?: string };
          if (!flagInput.reason) {
            return { success: false, toolName: name, error: 'flag_for_human_review requires a reason' };
          }
          await this.flagForHumanReview(context, {
            reason: flagInput.reason,
            suggested_action: flagInput.suggested_action,
          });
          // No checkpoint action - human review is a pause, not a progression
          break;
        }

        default:
          logger.error({ traceId: this.traceId, tool: name }, 'Unknown tool attempted');
          return { success: false, toolName: name, error: `Unknown tool: ${name}` };
      }

      // FIX J1/J2: Mark tool as executed AFTER successful completion
      // This ensures we don't mark failed executions, allowing retries
      await markToolExecuted(toolHash, this.traceId);
      logger.debug(
        { traceId: this.traceId, tool: name, toolHash },
        'Tool execution marked as complete (idempotency recorded)'
      );

      // Audit log: successful tool execution
      auditEventService.logToolExecuted(context.appointmentRequestId, {
        traceId: this.traceId,
        toolName: name,
        input: input as Record<string, unknown>,
        result: 'success',
      });

      // FIX RSA-1: Return checkpoint action for caller to update state
      return { success: true, toolName: name, checkpointAction, emailSentTo };
    } catch (error) {
      // FIX T1: Catch errors and return explicit failure result
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error({ traceId: this.traceId, tool: name, error: errorMsg }, 'Tool execution failed');

      // Audit log: failed tool execution
      auditEventService.logToolFailed(context.appointmentRequestId, {
        traceId: this.traceId,
        toolName: name,
        input: input as Record<string, unknown>,
        result: 'failed',
        error: errorMsg,
      });

      // Record the failure in the database for admin visibility
      await prisma.appointmentRequest.update({
        where: { id: context.appointmentRequestId },
        data: {
          lastToolExecutionFailed: true,
          lastToolFailureReason: errorMsg.slice(0, 500), // Limit length
        },
        select: { id: true },
      });

      return { success: false, toolName: name, error: errorMsg };
    }
  }

  // ─── Side-Effect Methods ──────────────────────────────────────────────────

  /**
   * Update therapist availability in Notion
   */
  private async updateTherapistAvailability(
    context: SchedulingContext,
    params: { availability: { [day: string]: string } }
  ): Promise<void> {
    logger.info(
      { traceId: this.traceId, availability: params.availability },
      'Updating therapist availability'
    );

    try {
      // Get the therapist's Notion ID from the appointment request
      const appointmentRequest = await prisma.appointmentRequest.findUnique({
        where: { id: context.appointmentRequestId },
        select: { therapistNotionId: true },
      });

      if (!appointmentRequest?.therapistNotionId) {
        logger.error({ traceId: this.traceId }, 'No therapist Notion ID found');
        return;
      }

      await notionService.updateTherapistAvailability(
        appointmentRequest.therapistNotionId,
        params.availability
      );

      logger.info(
        { traceId: this.traceId, therapistNotionId: appointmentRequest.therapistNotionId },
        'Therapist availability updated in Notion'
      );
    } catch (error) {
      logger.error(
        { traceId: this.traceId, error },
        'Failed to update therapist availability'
      );
      // Re-throw to signal failure to the tool execution handler
      // This ensures Claude knows the tool failed and can respond appropriately
      throw error;
    }
  }

  /**
   * Normalize email body formatting.
   *
   * SIMPLIFIED: Instead of complex paragraph-joining logic, we now only:
   * 1. Normalize line endings
   * 2. Fix signature formatting (the main issue Claude sometimes gets wrong)
   * 3. Clean up excessive blank lines
   *
   * We rely on the system prompt to instruct Claude on proper formatting.
   * Any extra line breaks Claude adds are cosmetic - email clients handle them fine.
   */
  private normalizeEmailBody(body: string): string {
    return body
      // Normalize line endings
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      // Fix signature on same line: "Best wishes Justin" → "Best wishes\nJustin"
      .replace(
        /\b(Best wishes|Best|Thanks|Regards|Cheers|Sincerely|Kind regards|Warm regards|All the best)[,]?\s+(Justin)\s*$/gim,
        '$1\n$2'
      )
      // Collapse excessive blank lines (3+ newlines → 2)
      .replace(/\n{3,}/g, '\n\n')
      // Clean up whitespace-only lines
      .replace(/\n[ \t]+\n/g, '\n\n')
      // Remove trailing whitespace from lines
      .replace(/[ \t]+\n/g, '\n')
      .trim();
  }

  /**
   * Send an email via Gmail API or queue for later
   * Stores Gmail thread ID on first send for deterministic email routing
   * Tracks separate thread IDs for client and therapist conversations
   *
   * IMPORTANT: This method handles Gmail threading by:
   * 1. Looking up the existing thread ID for the recipient (client or therapist)
   * 2. If a thread exists, including the thread ID to keep the conversation together
   * 3. Storing new thread IDs for future emails
   */
  private async sendEmail(
    params: {
      to: string;
      subject: string;
      body: string;
    },
    appointmentRequestId?: string
  ): Promise<void> {
    // Ensure subject includes "Spill" for brand consistency
    let normalizedSubject = params.subject;
    if (!params.subject.toLowerCase().includes('spill')) {
      // Prepend "Spill - " to subjects that don't include "Spill"
      normalizedSubject = `Spill - ${params.subject}`;
      logger.info(
        { traceId: this.traceId, originalSubject: params.subject, normalizedSubject },
        'Added "Spill" prefix to email subject'
      );
    }

    // Normalize email body to remove mid-paragraph line breaks
    const normalizedBody = this.normalizeEmailBody(params.body);

    // DEBUG: Log the raw and normalized body to trace line break issues
    const originalLineBreaks = (params.body.match(/\n/g) || []).length;
    const normalizedLineBreaks = (normalizedBody.match(/\n/g) || []).length;
    logger.info(
      {
        traceId: this.traceId,
        to: params.to,
        subject: params.subject,
        originalBodyLength: params.body.length,
        normalizedBodyLength: normalizedBody.length,
        originalLineBreaks,
        normalizedLineBreaks,
        lineBreaksRemoved: originalLineBreaks - normalizedLineBreaks,
        normalizedBodyPreview: normalizedBody.substring(0, 500).replace(/\n/g, '\\n'),
      },
      'Sending email - body normalization applied'
    );

    // Use normalized subject and body for the rest of the function
    const emailParams = { ...params, subject: normalizedSubject, body: normalizedBody };

    try {
      // Look up existing thread info to maintain conversation threading
      let existingThreadId: string | null = null;
      let isTherapistEmail = false;
      let trackingCode: string | null = null;

      if (appointmentRequestId) {
        const existing = await prisma.appointmentRequest.findUnique({
          where: { id: appointmentRequestId },
          select: {
            gmailThreadId: true,
            therapistGmailThreadId: true,
            therapistEmail: true,
            initialMessageId: true,
            trackingCode: true, // Fetch tracking code for subject embedding
          },
        });

        if (existing) {
          // Determine if this is a therapist or client email by comparing addresses
          isTherapistEmail = params.to.toLowerCase() === existing.therapistEmail.toLowerCase();

          // Get the appropriate thread ID for this recipient
          existingThreadId = isTherapistEmail
            ? existing.therapistGmailThreadId
            : existing.gmailThreadId;

          // Store tracking code for subject embedding
          trackingCode = existing.trackingCode;

          logger.info(
            {
              traceId: this.traceId,
              to: params.to,
              isTherapistEmail,
              existingThreadId,
              trackingCode,
            },
            'Determined recipient type, existing thread, and tracking code'
          );
        }
      }

      // FIX A1: ATOMIC CHECK using updateMany with condition to prevent TOCTOU
      // This atomically verifies human control is disabled AND sets a processing flag
      // The email will only be sent if the update succeeds
      if (appointmentRequestId) {
        // Use updateMany with condition - if human control is enabled, no rows are updated
        // This is atomic at the database level, preventing any race condition
        const canSend = await prisma.appointmentRequest.updateMany({
          where: {
            id: appointmentRequestId,
            humanControlEnabled: false, // Only proceed if human control is disabled
          },
          data: {
            lastActivityAt: new Date(), // Update activity timestamp as side effect
          },
        });

        if (canSend.count === 0) {
          // Either appointment doesn't exist or human control is enabled
          const current = await prisma.appointmentRequest.findUnique({
            where: { id: appointmentRequestId },
            select: { humanControlEnabled: true },
          });

          if (current?.humanControlEnabled) {
            logger.warn(
              { traceId: this.traceId, appointmentRequestId, to: params.to },
              'Human control enabled - aborting email send (atomic check)'
            );
            return; // Silently abort - human took over
          }
          // If current is null, the appointment was deleted - also abort
          if (!current) {
            logger.warn(
              { traceId: this.traceId, appointmentRequestId },
              'Appointment not found - aborting email send'
            );
            return;
          }
        }
      }

      // Prepend tracking code to subject for deterministic matching
      // This ensures emails can be matched to the correct appointment even without thread IDs
      // Code goes at START of subject for better visibility
      const subjectWithTracking = trackingCode
        ? prependTrackingCodeToSubject(emailParams.subject, trackingCode)
        : emailParams.subject;

      // Send email, including thread ID if we have one to maintain the conversation
      const result = await emailProcessingService.sendEmail({
        ...emailParams,
        subject: subjectWithTracking,
        threadId: existingThreadId || undefined,
      });

      logger.info(
        { traceId: this.traceId, to: params.to, threadId: result.threadId, isTherapistEmail },
        'Email sent successfully via Gmail'
      );

      // Audit log: email sent
      if (appointmentRequestId) {
        auditEventService.logEmailSent(appointmentRequestId, {
          traceId: this.traceId,
          from: EMAIL.FROM_ADDRESS,
          to: emailParams.to,
          subject: emailParams.subject,
          bodyPreview: emailParams.body.slice(0, 200),
          gmailMessageId: result.messageId,
        });
      }

      // Store thread ID on first email for deterministic matching
      // Uses atomic conditional update to prevent race conditions
      if (appointmentRequestId && result.threadId) {
        try {
          if (isTherapistEmail) {
            // Store therapist thread ID if not already set (atomic conditional update)
            const updated = await prisma.appointmentRequest.updateMany({
              where: {
                id: appointmentRequestId,
                therapistGmailThreadId: null, // Only update if not already set
              },
              data: {
                therapistGmailThreadId: result.threadId,
              },
            });

            if (updated.count > 0) {
              logger.info(
                { traceId: this.traceId, appointmentRequestId, threadId: result.threadId },
                'Stored therapist Gmail thread ID for appointment'
              );
            } else {
              // CRITICAL: Check if storage unexpectedly failed (no thread ID set but update returned 0)
              const current = await prisma.appointmentRequest.findUnique({
                where: { id: appointmentRequestId },
                select: { therapistGmailThreadId: true },
              });
              if (!current?.therapistGmailThreadId) {
                logger.error(
                  { traceId: this.traceId, appointmentRequestId, threadId: result.threadId },
                  'CRITICAL: Failed to store therapist thread ID - email matching may be unreliable'
                );
              }
            }
          } else {
            // Store client thread ID if not already set (atomic conditional update)
            const updated = await prisma.appointmentRequest.updateMany({
              where: {
                id: appointmentRequestId,
                gmailThreadId: null, // Only update if not already set
              },
              data: {
                gmailThreadId: result.threadId,
                initialMessageId: result.messageId,
              },
            });

            if (updated.count > 0) {
              logger.info(
                { traceId: this.traceId, appointmentRequestId, threadId: result.threadId },
                'Stored client Gmail thread ID for appointment'
              );
            } else {
              // CRITICAL: Check if storage unexpectedly failed (no thread ID set but update returned 0)
              const current = await prisma.appointmentRequest.findUnique({
                where: { id: appointmentRequestId },
                select: { gmailThreadId: true },
              });
              if (!current?.gmailThreadId) {
                logger.error(
                  { traceId: this.traceId, appointmentRequestId, threadId: result.threadId },
                  'CRITICAL: Failed to store client thread ID - email matching may be unreliable'
                );
              }
            }
          }
        } catch (storeErr) {
          logger.error(
            { traceId: this.traceId, error: storeErr, appointmentRequestId },
            'CRITICAL: Failed to store thread ID - email routing may be unreliable'
          );
        }
      }

      // FIX ST2: Activity recording now happens atomically in storeConversationState
      // below. No separate call needed - this prevents inconsistency if one succeeds
      // and the other fails.

      // Track when we send emails to therapist for response time metrics
      if (appointmentRequestId && isTherapistEmail) {
        try {
          // Lazy import to avoid circular dependency
          const { AIConversationService } = await import('./ai-conversation.service');
          const conversationService = new AIConversationService(this.traceId);

          const currentState = await conversationService.getConversationState(appointmentRequestId);
          if (currentState) {
            const { _version, ...stateWithoutVersion } = currentState;
            // Store response tracking data in conversation state
            const responseTracking = stateWithoutVersion.responseTracking || {};
            responseTracking.lastEmailSentToTherapist = new Date().toISOString();
            responseTracking.pendingSince = responseTracking.lastEmailSentToTherapist;
            stateWithoutVersion.responseTracking = responseTracking;
            await conversationService.storeConversationState(appointmentRequestId, stateWithoutVersion, _version);
            logger.debug(
              { traceId: this.traceId, appointmentRequestId },
              'Recorded therapist email send time for response tracking'
            );
          }
        } catch (trackingError) {
          // Non-critical - don't fail email send if tracking fails
          logger.warn(
            { traceId: this.traceId, error: trackingError },
            'Failed to record response tracking data'
          );
        }
      }
    } catch (sendError) {
      logger.warn(
        { traceId: this.traceId, error: sendError },
        'Could not send email directly, queuing for later'
      );

      // Fallback: queue via BullMQ for later processing (with DB audit trail)
      // FIX #24: Use normalized params (with tracking code and body normalization)
      try {
        await emailQueueService.enqueue({
          to: emailParams.to,
          subject: emailParams.subject,
          body: emailParams.body,
          appointmentId: appointmentRequestId,
        });
        logger.info(
          { traceId: this.traceId, to: params.to },
          'Email queued successfully via BullMQ'
        );
      } catch (dbError) {
        logger.error(
          { traceId: this.traceId, error: dbError },
          'Failed to queue email'
        );
      }

      // Log email queued (without sensitive body content)
      logger.info(
        { traceId: this.traceId, to: params.to, subject: params.subject },
        'Email queued for sending'
      );
    }
  }

  /**
   * Mark scheduling as complete and send confirmation emails
   * Also handles rescheduling: resets follow-up flags when appointment time changes
   *
   * Delegates to appointmentLifecycleService for:
   * - Atomic status update (prevents double-booking race conditions)
   * - Confirmation emails to client and therapist
   * - Slack notification
   * - Therapist status update
   * - User sync to Notion
   */
  private async markComplete(
    context: SchedulingContext,
    params: { confirmed_datetime: string; notes?: string }
  ): Promise<void> {
    logger.info(
      { traceId: this.traceId, appointmentRequestId: context.appointmentRequestId, params },
      'Marking scheduling complete via lifecycle service'
    );

    // Check if this is a reschedule (already confirmed appointment)
    const existing = await prisma.appointmentRequest.findUnique({
      where: { id: context.appointmentRequestId },
      select: {
        status: true,
        confirmedDateTime: true,
        humanControlEnabled: true,
        reschedulingInProgress: true,
      },
    });

    // DEFENSE IN DEPTH: Re-check human control before critical operation
    if (existing?.humanControlEnabled) {
      logger.info(
        {
          traceId: this.traceId,
          appointmentRequestId: context.appointmentRequestId,
        },
        'Human control enabled - skipping markComplete'
      );
      return;
    }

    // IDEMPOTENCY CHECK: If already confirmed with the same datetime, skip duplicate processing
    // Use semantic comparison to handle variations like "Monday 3rd" vs "Monday 3"
    const { areDatetimesEqual } = await import('../utils/date-parser');
    if (
      existing?.status === 'confirmed' &&
      areDatetimesEqual(existing?.confirmedDateTime, params.confirmed_datetime)
    ) {
      logger.info(
        {
          traceId: this.traceId,
          appointmentRequestId: context.appointmentRequestId,
          existingDateTime: existing?.confirmedDateTime,
          newDateTime: params.confirmed_datetime,
        },
        'Appointment already confirmed with same datetime - skipping duplicate processing (idempotent)'
      );
      return;
    }

    const isReschedule = existing?.status === 'confirmed' && (existing?.confirmedDateTime || existing?.reschedulingInProgress);

    // Define allowed statuses that can transition to confirmed
    // - For new confirmations: pending, contacted, negotiating
    // - For reschedules: confirmed (with different datetime, or rescheduling after admin cleared date)
    const allowedFromStatuses: AppointmentStatus[] = isReschedule
      ? [APPOINTMENT_STATUS.CONFIRMED]
      : [APPOINTMENT_STATUS.PENDING, APPOINTMENT_STATUS.CONTACTED, APPOINTMENT_STATUS.NEGOTIATING];

    // Parse the confirmed datetime for post-booking follow-ups
    const { parseConfirmedDateTime } = await import('../utils/date-parser');
    const confirmedDateTimeParsed = parseConfirmedDateTime(
      params.confirmed_datetime,
      new Date()
    );

    if (!confirmedDateTimeParsed) {
      logger.warn(
        { traceId: this.traceId, confirmedDateTime: params.confirmed_datetime },
        'Could not parse confirmed datetime - follow-up emails may not be sent automatically'
      );
    }

    // Use lifecycle service for atomic confirmation with all side effects
    const result = await appointmentLifecycleService.transitionToConfirmed({
      appointmentId: context.appointmentRequestId,
      confirmedDateTime: params.confirmed_datetime,
      confirmedDateTimeParsed,
      notes: params.notes,
      source: 'agent',
      sendEmails: true,
      // Atomic options to prevent race conditions
      atomic: {
        requireStatuses: allowedFromStatuses,
        requireHumanControlDisabled: true,
      },
      // Reschedule options
      reschedule: isReschedule
        ? {
            previousConfirmedDateTime: existing.confirmedDateTime || undefined,
            resetFollowUpFlags: true,
          }
        : undefined,
    });

    // Log result
    if (result.atomicSkipped) {
      logger.info(
        {
          traceId: this.traceId,
          appointmentRequestId: context.appointmentRequestId,
          previousStatus: result.previousStatus,
        },
        'Appointment confirmation skipped atomically (human control or concurrent update)'
      );
      return;
    }

    if (result.skipped) {
      logger.info(
        {
          traceId: this.traceId,
          appointmentRequestId: context.appointmentRequestId,
        },
        'Appointment confirmation skipped (idempotent)'
      );
      return;
    }

    // Audit log: status change to confirmed
    auditEventService.logStatusChange(context.appointmentRequestId, 'agent', {
      traceId: this.traceId,
      previousStatus: result.previousStatus,
      newStatus: 'confirmed',
      reason: isReschedule
        ? `Rescheduled to ${params.confirmed_datetime}`
        : `Confirmed for ${params.confirmed_datetime}`,
    });

    // Invalidate therapist cache so frontend sees updated availability
    try {
      await notionService.invalidateCache();
      logger.info(
        { traceId: this.traceId },
        'Therapist cache invalidated after booking confirmation'
      );
    } catch (err) {
      logger.error(
        { traceId: this.traceId, err },
        'Failed to invalidate therapist cache (non-critical)'
      );
    }

    logger.info(
      { traceId: this.traceId, appointmentRequestId: context.appointmentRequestId, isReschedule },
      'Appointment confirmed via lifecycle service'
    );
  }

  /**
   * Cancel an appointment and free up the therapist for other bookings
   *
   * Delegates to appointmentLifecycleService for:
   * - Atomic status update (prevents race conditions)
   * - Therapist status update
   * - Slack notification (if enabled)
   * - Cancellation emails to both client and therapist
   */
  private async cancelAppointment(
    context: SchedulingContext,
    params: { reason: string; cancelled_by: 'client' | 'therapist' }
  ): Promise<void> {
    logger.info(
      {
        traceId: this.traceId,
        appointmentRequestId: context.appointmentRequestId,
        reason: params.reason,
        cancelledBy: params.cancelled_by,
      },
      'Cancelling appointment via lifecycle service'
    );

    // Get current appointment to check human control (defense in depth)
    const appointment = await prisma.appointmentRequest.findUnique({
      where: { id: context.appointmentRequestId },
      select: {
        status: true,
        humanControlEnabled: true,
      },
    });

    if (!appointment) {
      logger.error(
        { traceId: this.traceId, appointmentRequestId: context.appointmentRequestId },
        'Appointment not found for cancellation'
      );
      return;
    }

    // DEFENSE IN DEPTH: Re-check human control before critical operation
    if (appointment.humanControlEnabled) {
      logger.info(
        {
          traceId: this.traceId,
          appointmentRequestId: context.appointmentRequestId,
        },
        'Human control enabled - skipping cancelAppointment'
      );
      return;
    }

    // Use lifecycle service for atomic cancellation with all side effects
    const result = await appointmentLifecycleService.transitionToCancelled({
      appointmentId: context.appointmentRequestId,
      reason: params.reason,
      cancelledBy: params.cancelled_by,
      source: 'agent',
      // Atomic options to prevent race conditions
      atomic: {
        requireStatusNotIn: [APPOINTMENT_STATUS.CANCELLED],
        requireHumanControlDisabled: true,
      },
    });

    // Log result
    if (result.atomicSkipped) {
      logger.warn(
        {
          traceId: this.traceId,
          appointmentRequestId: context.appointmentRequestId,
          previousStatus: result.previousStatus,
        },
        'Cancellation skipped atomically (human control or already cancelled)'
      );
      return;
    }

    if (result.skipped) {
      logger.info(
        {
          traceId: this.traceId,
          appointmentRequestId: context.appointmentRequestId,
        },
        'Appointment already cancelled - skipping (idempotent)'
      );
      return;
    }

    // Audit log: status change to cancelled
    auditEventService.logStatusChange(context.appointmentRequestId, 'agent', {
      traceId: this.traceId,
      previousStatus: result.previousStatus,
      newStatus: 'cancelled',
      reason: `Cancelled by ${params.cancelled_by}: ${params.reason}`,
    });

    // Invalidate therapist cache so frontend sees updated availability
    try {
      await notionService.invalidateCache();
      logger.info(
        { traceId: this.traceId },
        'Therapist cache invalidated after cancellation'
      );
    } catch (err) {
      logger.error(
        { traceId: this.traceId, err },
        'Failed to invalidate therapist cache (non-critical)'
      );
    }

    logger.info(
      {
        traceId: this.traceId,
        appointmentRequestId: context.appointmentRequestId,
        wasConfirmed: result.previousStatus === APPOINTMENT_STATUS.CONFIRMED,
      },
      'Appointment cancelled via lifecycle service'
    );
  }

  /**
   * Flag appointment for human review when agent is uncertain
   * Enables human control mode so admin can review and respond
   */
  private async flagForHumanReview(
    context: SchedulingContext,
    params: { reason: string; suggested_action?: string }
  ): Promise<void> {
    logger.info(
      {
        traceId: this.traceId,
        appointmentRequestId: context.appointmentRequestId,
        reason: params.reason,
        suggestedAction: params.suggested_action,
      },
      'Agent flagging appointment for human review'
    );

    // Build the reason message to store
    const controlReason = params.suggested_action
      ? `Agent uncertain: ${params.reason}\n\nSuggested action: ${params.suggested_action}`
      : `Agent uncertain: ${params.reason}`;

    // Enable human control mode
    await prisma.appointmentRequest.update({
      where: { id: context.appointmentRequestId },
      data: {
        humanControlEnabled: true,
        humanControlTakenBy: 'agent-flagged',
        humanControlTakenAt: new Date(),
        humanControlReason: controlReason,
      },
      select: { id: true },
    });

    logger.info(
      {
        traceId: this.traceId,
        appointmentRequestId: context.appointmentRequestId,
      },
      'Human control enabled - appointment flagged for review'
    );

    // Log human_control audit event
    auditEventService.log(context.appointmentRequestId, 'human_control', 'agent', {
      enabled: true,
      reason: controlReason,
    });

    // Send Slack notification for human review flagged
    await slackNotificationService.notifyHumanReviewFlagged(
      context.appointmentRequestId,
      context.userName,
      context.therapistName,
      params.reason
    );
  }

  /**
   * Recommend cancelling a match when the user has declined the therapist.
   * Sends a Slack notification to the admin so they can cancel and free up
   * the therapist for other users. Also enables human control so the admin
   * can review the conversation and take action.
   */
  private async recommendCancelMatch(
    context: SchedulingContext,
    reason: string
  ): Promise<void> {
    logger.info(
      {
        traceId: this.traceId,
        appointmentRequestId: context.appointmentRequestId,
        reason,
      },
      'Agent recommending match cancellation'
    );

    // Enable human control and set closure recommendation fields so the admin
    // can action this via the existing /action-closure endpoint.
    await prisma.appointmentRequest.update({
      where: { id: context.appointmentRequestId },
      data: {
        humanControlEnabled: true,
        humanControlTakenBy: 'agent-flagged',
        humanControlTakenAt: new Date(),
        humanControlReason: `Cancel match recommended: ${reason}`,
        closureRecommendedAt: new Date(),
        closureRecommendedReason: `Match cancellation recommended: ${reason}`,
        closureRecommendationActioned: false,
      },
      select: { id: true },
    });

    // Log human_control audit event
    auditEventService.log(context.appointmentRequestId, 'human_control', 'agent', {
      enabled: true,
      reason: `Cancel match recommended: ${reason}`,
    });

    // Send targeted Slack notification recommending match cancellation
    await slackNotificationService.notifyCancelMatchRecommended(
      context.appointmentRequestId,
      context.userName,
      context.therapistName,
      reason
    );
  }
}
