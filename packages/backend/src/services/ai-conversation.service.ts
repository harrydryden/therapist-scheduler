/**
 * AI Conversation Service
 *
 * Extracted from justin-time.service.ts — handles conversation state management,
 * state persistence with optimistic locking, conversation trimming, and the
 * lightweight inquiry reply flow (weekly mailing responses).
 *
 * This module owns all read/write operations on conversation state JSON,
 * including retry logic and compensation recording for failed saves.
 */

import Anthropic from '@anthropic-ai/sdk';
import { anthropicClient } from '../utils/anthropic-client';
import { CLAUDE_MODELS, MODEL_CONFIG } from '../config/models';
import { logger } from '../utils/logger';
import { prisma } from '../utils/database';
import { emailProcessingService } from './email-processing.service';
import { emailQueueService } from './email-queue.service';
import { parseConversationState } from '../utils/json-parser';
import { extractConversationMeta } from '../utils/conversation-meta';
import { wrapUntrustedContent } from '../utils/content-sanitizer';
import { getSettingValue } from './settings.service';
import { CONVERSATION_LIMITS } from '../constants';
import { resilientCall } from '../utils/resilient-call';
import { circuitBreakerRegistry, CIRCUIT_BREAKER_CONFIGS } from '../utils/circuit-breaker';
import { ConcurrentModificationError } from '../errors';
import type { ConversationState } from '../types';
import type { Prisma } from '@prisma/client';
import {
  stageFromAction,
  updateCheckpoint,
  type ConversationAction,
  type ConversationCheckpoint,
  type ConversationStage,
} from '../services/conversation-checkpoint.service';

import type { ConversationMessage } from './scheduling-context.service';

const claudeCircuitBreaker = circuitBreakerRegistry.getOrCreate(CIRCUIT_BREAKER_CONFIGS.CLAUDE_API);

/** Truncate message content to prevent state size bombs */
export function truncateMessageContent(content: string): string {
  const MAX_LENGTH = CONVERSATION_LIMITS.MAX_MESSAGE_LENGTH;
  const SUFFIX = CONVERSATION_LIMITS.TRUNCATION_SUFFIX;
  if (content.length <= MAX_LENGTH) return content;
  return content.slice(0, MAX_LENGTH - SUFFIX.length) + SUFFIX;
}

export class AIConversationService {
  private traceId: string;

  constructor(traceId?: string) {
    this.traceId = traceId || 'ai-conversation';
  }

  /**
   * Store conversation state in database with optimistic locking
   * Uses updatedAt as version check to prevent concurrent overwrites
   * Automatically trims state if it exceeds size limits
   *
   * FIX ST2: Atomic state storage with activity recording
   * Previously, recordActivity was called separately which could succeed
   * while storeConversationState failed, creating inconsistent data.
   * Now includes activity update in the same atomic operation.
   */
  async storeConversationState(
    appointmentRequestId: string,
    state: { systemPrompt?: string; messages: ConversationMessage[] },
    expectedUpdatedAt?: Date
  ): Promise<void> {
    // Trim state if needed to prevent unbounded growth
    const trimmedState = this.trimConversationState(state);
    const stateJson = JSON.stringify(trimmedState);
    const now = new Date();
    // FIX #21: Extract denormalized metadata to avoid loading full blob in list queries
    const { messageCount, checkpointStage } = extractConversationMeta(stateJson);

    if (expectedUpdatedAt) {
      // Use optimistic locking - only update if version matches
      // FIX ST2: Include activity recording in same atomic operation
      const result = await prisma.appointmentRequest.updateMany({
        where: {
          id: appointmentRequestId,
          updatedAt: expectedUpdatedAt,
        },
        data: {
          conversationState: stateJson,
          updatedAt: now,
          // FIX ST2: Atomic activity recording - no separate call needed
          lastActivityAt: now,
          isStale: false,
          messageCount,
          checkpointStage,
        },
      });

      if (result.count === 0) {
        // Version mismatch - another process modified the state.
        // Use the typed error so callers can `instanceof`-check rather than
        // string-matching the message (which is fragile across rephrasings).
        throw new ConcurrentModificationError(appointmentRequestId);
      }
    } else {
      // Legacy call without version check (for initial state creation)
      // FIX ST2: Include activity recording in same atomic operation
      await prisma.appointmentRequest.update({
        where: { id: appointmentRequestId },
        data: {
          conversationState: stateJson,
          updatedAt: now,
          // FIX ST2: Atomic activity recording
          lastActivityAt: now,
          isStale: false,
          messageCount,
          checkpointStage,
        },
        select: { id: true },
      });
    }
  }

  /**
   * Atomically apply a checkpoint mutation AND optional extra field updates.
   *
   * The single source of truth for checkpoint state is
   * `conversationState.checkpoint` (JSON). The denormalized DB column
   * `checkpointStage` is derived from the JSON and must never be written
   * directly by callers — use this helper instead.
   *
   * This exists because prior code had ~4 different direct writers of
   * `appointmentRequest.checkpointStage` (chase-email, ai-tool-executor,
   * justin-time reschedule path, dismissClosureRecommendation). They drifted
   * out of sync with the JSON and caused real bugs. Routing everything
   * through this helper enforces the invariant column == derive(JSON).
   *
   * Handles optimistic-lock conflicts with a small retry budget. If the
   * caller supplies `extraWhere` (e.g. a sentinel guard), a lost-lock is
   * treated as a semantic failure — we don't retry past a changed guard.
   *
   * Use `applyCheckpointAction` for the common case of "advance via a
   * ConversationAction". Use this lower-level `applyCheckpointUpdate` when
   * the new checkpoint depends on the current one (e.g. dismissing closure
   * and restoring an inferred prior stage).
   */
  async applyCheckpointUpdate(
    appointmentRequestId: string,
    mutate: (current: ConversationCheckpoint | null) => ConversationCheckpoint,
    options?: {
      extraUpdates?: Prisma.AppointmentRequestUpdateInput;
      extraWhere?: Prisma.AppointmentRequestWhereInput;
      maxRetries?: number;
    }
  ): Promise<{ applied: boolean; stage: string | null }> {
    const maxRetries = options?.maxRetries ?? 3;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const record = await prisma.appointmentRequest.findUnique({
        where: { id: appointmentRequestId },
        select: { conversationState: true, updatedAt: true },
      });
      if (!record) {
        return { applied: false, stage: null };
      }

      const state = record.conversationState
        ? parseConversationState(record.conversationState as Prisma.JsonValue)
        : null;
      if (!state) {
        // No conversation state yet — can't apply a checkpoint mutation.
        // Happens very early in the lifecycle before the agent runs.
        return { applied: false, stage: null };
      }

      state.checkpoint = mutate(state.checkpoint ?? null);
      const stateJson = JSON.stringify(state);
      const { messageCount, checkpointStage } = extractConversationMeta(stateJson);

      const now = new Date();
      const result = await prisma.appointmentRequest.updateMany({
        where: {
          id: appointmentRequestId,
          updatedAt: record.updatedAt,
          ...options?.extraWhere,
        },
        data: {
          conversationState: stateJson,
          messageCount,
          checkpointStage,
          updatedAt: now,
          ...options?.extraUpdates,
        },
      });

      if (result.count === 1) {
        return { applied: true, stage: checkpointStage };
      }

      // Lost the optimistic lock. If the caller's extraWhere guard failed
      // (e.g. sentinel changed), that's a semantic failure — stop retrying.
      if (options?.extraWhere) {
        const stillMatchesGuard = await prisma.appointmentRequest.count({
          where: { id: appointmentRequestId, ...options.extraWhere },
        });
        if (stillMatchesGuard === 0) {
          logger.info(
            { appointmentRequestId },
            'applyCheckpointUpdate: caller guard no longer matches, stopping retry'
          );
          return { applied: false, stage: null };
        }
      }

      logger.debug(
        { appointmentRequestId, attempt: attempt + 1 },
        'applyCheckpointUpdate: optimistic lock conflict, retrying'
      );
    }

    logger.warn(
      { appointmentRequestId, maxRetries },
      'applyCheckpointUpdate: exhausted retry budget on optimistic lock conflicts'
    );
    return { applied: false, stage: null };
  }

  /**
   * Convenience wrapper for the common "advance checkpoint via a
   * ConversationAction" case. Delegates to `applyCheckpointUpdate`.
   */
  async applyCheckpointAction(
    appointmentRequestId: string,
    action: ConversationAction,
    options?: {
      extraUpdates?: Prisma.AppointmentRequestUpdateInput;
      extraWhere?: Prisma.AppointmentRequestWhereInput;
      contextUpdates?: { lastEmailSentTo?: 'user' | 'therapist' };
      maxRetries?: number;
    }
  ): Promise<{ applied: boolean; stage: string | null }> {
    return this.applyCheckpointUpdate(
      appointmentRequestId,
      (current) => updateCheckpoint(current, action, null, options?.contextUpdates),
      options,
    );
  }

  /**
   * FIX RSA-4: Retry state save with exponential backoff
   * If all retries fail, records compensation data for manual recovery
   */
  async storeConversationStateWithRetry(
    appointmentRequestId: string,
    state: { systemPrompt: string; messages: ConversationMessage[] },
    expectedUpdatedAt: Date,
    executedTools: Array<{ toolName: string; emailSentTo?: 'user' | 'therapist'; timestamp: string }>
  ): Promise<{ success: boolean; retriesUsed: number }> {
    const MAX_RETRIES = 3;
    const BASE_DELAY_MS = 100;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        await this.storeConversationState(appointmentRequestId, state, expectedUpdatedAt);
        return { success: true, retriesUsed: attempt };
      } catch (error) {
        // Don't retry optimistic locking conflicts - they indicate a real conflict
        if (error instanceof ConcurrentModificationError) {
          logger.warn(
            { traceId: this.traceId, appointmentRequestId, attempt },
            'State save conflict - not retrying (concurrent modification)'
          );
          break;
        }
        const errorMsg = error instanceof Error ? error.message : 'Unknown';

        if (attempt < MAX_RETRIES - 1) {
          const delay = BASE_DELAY_MS * Math.pow(2, attempt);
          logger.warn(
            { traceId: this.traceId, appointmentRequestId, attempt, delay, error: errorMsg },
            'State save failed - retrying'
          );
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }

    // All retries exhausted - record compensation data
    const emailTools = executedTools.filter(t =>
      t.toolName === 'send_user_email' || t.toolName === 'send_therapist_email'
    );

    if (emailTools.length > 0) {
      // Log critical compensation data for manual recovery
      logger.error(
        {
          traceId: this.traceId,
          appointmentRequestId,
          compensationRequired: true,
          emailsSent: emailTools,
          stateSnapshot: {
            messageCount: state.messages.length,
            lastMessage: state.messages.slice(-1)[0],
          },
        },
        'COMPENSATION REQUIRED: Emails sent but state save failed - manual recovery needed'
      );

      // Attempt to persist minimal compensation record to database
      try {
        const existingRecord = await prisma.appointmentRequest.findUnique({
          where: { id: appointmentRequestId },
          select: { notes: true },
        });
        const compensationNote = `[COMPENSATION ${new Date().toISOString()}] Emails sent but state save failed. Emails: ${JSON.stringify(emailTools)}`;
        const newNotes = existingRecord?.notes
          ? `${compensationNote}\n\n${existingRecord.notes}`
          : compensationNote;

        await prisma.appointmentRequest.update({
          where: { id: appointmentRequestId },
          data: { notes: newNotes },
          select: { id: true },
        });
        logger.info(
          { traceId: this.traceId, appointmentRequestId },
          'Compensation record saved to notes field'
        );
      } catch (compensationError) {
        logger.error(
          { traceId: this.traceId, appointmentRequestId, error: compensationError },
          'Failed to save compensation record - data only in logs'
        );
      }
    }

    return { success: false, retriesUsed: MAX_RETRIES };
  }

  /**
   * Get conversation state from database with version info for optimistic locking
   */
  async getConversationState(
    appointmentRequestId: string
  ): Promise<ConversationState & { _version: Date } | null> {
    const request = await prisma.appointmentRequest.findUnique({
      where: { id: appointmentRequestId },
      select: { conversationState: true, updatedAt: true },
    });

    if (!request?.conversationState) {
      return null;
    }

    const parsed = parseConversationState(request.conversationState);
    if (!parsed) {
      return null;
    }

    return {
      ...parsed,
      _version: request.updatedAt,
    };
  }

  /**
   * Trim conversation state to prevent unbounded growth.
   *
   * Strategy: keep BOTH ends of the conversation, drop the middle.
   *   - First TRIM_KEEP_FIRST messages: initial booking context (who, what, when).
   *     The agent always needs these to understand what the conversation is about,
   *     even after a long reschedule chain.
   *   - Last (TRIM_TO_MESSAGES - TRIM_KEEP_FIRST - 1) messages: recent context.
   *   - One placeholder message in between explaining how many messages were dropped.
   *
   * The previous strategy kept only the tail, which meant a long reschedule
   * conversation could lose all the original booking context (who's involved,
   * what slots were considered, what the original ask was). At ~100 appts/day
   * this didn't bite often but it produced confusing agent behaviour on the
   * rare long thread.
   */
  trimConversationState(
    state: { systemPrompt?: string; messages: ConversationMessage[] }
  ): { systemPrompt?: string; messages: ConversationMessage[] } {
    const { MAX_MESSAGES, TRIM_TO_MESSAGES, MAX_STATE_BYTES, TRIM_KEEP_FIRST } = CONVERSATION_LIMITS;

    // Fast path: well below limits, return as-is. Skipping the JSON.stringify
    // here matters because storeConversationState stringifies the result on
    // every save — paying the cost twice on the hot path is wasted work.
    // The byte-size check below only fires when the count threshold doesn't.
    if (state.messages.length <= MAX_MESSAGES) {
      // Only stringify-for-size-check when the count is high enough that the
      // message blob could plausibly approach the byte limit. ~50KB per
      // message is a generous upper bound (we cap individual messages at 50KB
      // via truncateMessageContent).
      const couldBeOversized = state.messages.length * 2_000 > MAX_STATE_BYTES;
      if (!couldBeOversized || JSON.stringify(state).length <= MAX_STATE_BYTES) {
        return state;
      }
    }

    // Reserve one slot for the placeholder summary message; split the rest
    // between head (initial context) and tail (recent context).
    const keepFirst = Math.min(TRIM_KEEP_FIRST, state.messages.length);
    const keepLast = Math.max(0, TRIM_TO_MESSAGES - keepFirst - 1);
    const droppedCount = state.messages.length - keepFirst - keepLast;

    // If nothing would actually be dropped (very short conversation), return as-is
    if (droppedCount <= 0) {
      return state;
    }

    const head = state.messages.slice(0, keepFirst);
    const tail = state.messages.slice(-keepLast);
    const placeholder: ConversationMessage = {
      role: 'user',
      content: `[System Note: ${droppedCount} middle messages were trimmed to maintain performance. The first ${keepFirst} messages (initial booking context) and the last ${keepLast} messages (recent activity) are preserved.]`,
    };

    const trimmedMessages = [...head, placeholder, ...tail];

    logger.info(
      {
        originalCount: state.messages.length,
        trimmedCount: trimmedMessages.length,
        keepFirst,
        keepLast,
        droppedCount,
      },
      'Trimmed conversation state (head+tail strategy)'
    );

    return {
      systemPrompt: state.systemPrompt,
      messages: trimmedMessages,
    };
  }

  /**
   * Process a reply to the weekly promotional email (inquiry mode)
   * This is a lightweight handler for general questions - NOT for booking flows
   *
   * The agent answers questions about Spill's therapy services and directs
   * users to the booking URL to start an actual booking.
   */
  async processInquiryReply(
    inquiryId: string,
    emailContent: string,
    fromEmail: string,
    threadContext?: string
  ): Promise<{ success: boolean; message: string }> {
    logger.info(
      { traceId: this.traceId, inquiryId, fromEmail },
      'Processing weekly mailing inquiry reply'
    );

    try {
      // Get the inquiry record
      const inquiry = await prisma.weeklyMailingInquiry.findUnique({
        where: { id: inquiryId },
      });

      if (!inquiry) {
        throw new Error('Weekly mailing inquiry not found');
      }

      // Get booking URL from settings
      const bookingUrl = await getSettingValue<string>('weeklyMailing.webAppUrl');

      // Build lightweight inquiry system prompt
      const systemPrompt = await this.buildInquirySystemPrompt(
        inquiry.userName || 'User',
        bookingUrl
      );

      // Get or initialize conversation state
      let conversationState: ConversationState;
      if (inquiry.conversationState) {
        const parsed = parseConversationState(inquiry.conversationState);
        conversationState = parsed || { systemPrompt, messages: [] };
      } else {
        conversationState = { systemPrompt, messages: [] };
      }

      // Wrap email content for safety
      const safeEmailContent = wrapUntrustedContent(emailContent, 'email');

      // Build the new message
      let newMessage: string;
      if (threadContext) {
        const safeThreadContext = wrapUntrustedContent(threadContext, 'thread_history');
        newMessage = `A user who received our weekly promotional email has replied. Below is the conversation history and their new message.

${safeThreadContext}

=== NEW MESSAGE ===
From: ${fromEmail}
${safeEmailContent}

Please answer their question helpfully and direct them to the booking URL to schedule a session.`;
      } else {
        newMessage = `A user who received our weekly promotional email has replied:

From: ${fromEmail}
${safeEmailContent}

Please answer their question helpfully and direct them to the booking URL to schedule a session.`;
      }

      // Add to conversation state
      conversationState.messages.push({
        role: 'user',
        content: truncateMessageContent(newMessage),
      });

      // Tools available: send_email and unsubscribe_user
      const inquiryTools: Anthropic.Tool[] = [
        {
          name: 'send_email',
          description: 'Send an email response to the user',
          input_schema: {
            type: 'object',
            properties: {
              to: { type: 'string', description: 'Recipient email address' },
              subject: { type: 'string', description: 'Email subject line. MUST include "Spill" somewhere in the subject.' },
              body: { type: 'string', description: 'Email body content' },
            },
            required: ['to', 'subject', 'body'],
          },
        },
        {
          name: 'unsubscribe_user',
          description: 'Unsubscribe a user from weekly promotional emails. Use this when a user explicitly requests to be removed from the mailing list or asks to stop receiving emails.',
          input_schema: {
            type: 'object',
            properties: {
              email: { type: 'string', description: 'Email address to unsubscribe' },
              reason: { type: 'string', description: 'Brief note about why they unsubscribed (optional)' },
            },
            required: ['email'],
          },
        },
      ];

      // Build messages for Claude
      const messagesForClaude: Anthropic.MessageParam[] = conversationState.messages.map(msg => ({
        role: msg.role as 'user' | 'assistant',
        content: msg.content,
      }));

      // Call Claude
      const response = await resilientCall(
        () => anthropicClient.messages.create({
          model: CLAUDE_MODELS.AGENT,
          max_tokens: MODEL_CONFIG.agent.maxTokens,
          system: systemPrompt,
          tools: inquiryTools,
          messages: messagesForClaude,
        }),
        { context: 'processInquiryReply', traceId: this.traceId, circuitBreaker: claudeCircuitBreaker }
      );

      // Process response
      const toolCalls = response.content.filter(
        (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use'
      );
      const textBlocks = response.content.filter(
        (block): block is Anthropic.TextBlock => block.type === 'text'
      );
      const assistantText = textBlocks.map(b => b.text).join('\n');

      if (assistantText) {
        conversationState.messages.push({
          role: 'assistant',
          content: truncateMessageContent(assistantText),
        });
      }

      // Execute tool calls
      for (const toolCall of toolCalls) {
        if (toolCall.name === 'send_email') {
          const input = toolCall.input as { to: string; subject: string; body: string };

          // Ensure subject includes "Spill" for brand consistency
          let normalizedSubject = input.subject;
          if (!input.subject.toLowerCase().includes('spill')) {
            normalizedSubject = `Spill - ${input.subject}`;
            logger.info(
              { traceId: this.traceId, originalSubject: input.subject, normalizedSubject },
              'Added "Spill" prefix to inquiry email subject'
            );
          }

          logger.info(
            { traceId: this.traceId, inquiryId, to: input.to, subject: normalizedSubject },
            'Sending inquiry response email'
          );

          // Try to send directly, fall back to queue
          try {
            await emailProcessingService.sendEmail({
              to: input.to,
              subject: normalizedSubject,
              body: input.body,
              threadId: inquiry.gmailThreadId || undefined,
            });
          } catch (sendError) {
            logger.warn(
              { traceId: this.traceId, error: sendError },
              'Could not send inquiry email directly, queuing for later'
            );
            // Queue without appointmentId (inquiry emails don't have one)
            await emailQueueService.enqueue({
              to: input.to,
              subject: normalizedSubject,
              body: input.body,
            });
          }

          // Log tool execution
          conversationState.messages.push({
            role: 'user',
            content: `[Tool executed: send_email to ${input.to}]`,
          });
        } else if (toolCall.name === 'unsubscribe_user') {
          const input = toolCall.input as { email: string; reason?: string };

          logger.info(
            { traceId: this.traceId, inquiryId, email: input.email, reason: input.reason },
            'Unsubscribing user from weekly mailing list'
          );

          try {
            // Postgres is the source of truth for the subscribed flag now
            // that Notion has been retired. updateMany returns count=0 if
            // the user doesn't exist, which we treat as already-unsubscribed.
            const result = await prisma.user.updateMany({
              where: {
                email: input.email.toLowerCase(),
                subscribed: true,
              },
              data: { subscribed: false },
            });

            if (result.count > 0) {
              logger.info(
                { traceId: this.traceId, email: input.email },
                'User unsubscribed from weekly mailing list'
              );
            } else {
              logger.warn(
                { traceId: this.traceId, email: input.email },
                'User not found or already unsubscribed'
              );
            }

            // Mark the inquiry as resolved
            await prisma.weeklyMailingInquiry.update({
              where: { id: inquiryId },
              data: { status: 'resolved' },
            });

            // Log tool execution
            conversationState.messages.push({
              role: 'user',
              content: `[Tool executed: unsubscribe_user for ${input.email}${input.reason ? ` - Reason: ${input.reason}` : ''}]`,
            });
          } catch (unsubError) {
            logger.error(
              { traceId: this.traceId, error: unsubError, email: input.email },
              'Failed to unsubscribe user'
            );
            conversationState.messages.push({
              role: 'user',
              content: `[Tool failed: unsubscribe_user for ${input.email} - Error occurred]`,
            });
          }
        }
      }

      // Save conversation state
      await prisma.weeklyMailingInquiry.update({
        where: { id: inquiryId },
        data: {
          conversationState: JSON.stringify(conversationState),
          updatedAt: new Date(),
        },
      });

      return { success: true, message: 'Inquiry reply processed' };
    } catch (error) {
      logger.error(
        { error, traceId: this.traceId, inquiryId, fromEmail },
        'Failed to process weekly mailing inquiry reply'
      );
      throw error;
    }
  }

  /**
   * Build a lightweight system prompt for inquiry handling (not booking)
   */
  private async buildInquirySystemPrompt(userName: string, bookingUrl: string): Promise<string> {
    const agentName = await getSettingValue<string>('agent.fromName');
    const sessionDuration = await getSettingValue<number>('agent.sessionDurationMinutes');

    return `# ${agentName} - Inquiry Handler

You are ${agentName}, a friendly assistant responding to someone who replied to Spill's weekly promotional email.

## Your Role
This is an INQUIRY channel only - you answer questions and direct users to the booking website. You do NOT handle bookings here.

## Your Goal
1. Answer any questions the user has about Spill's therapy services
2. Be helpful, warm, and professional
3. **Always** direct them to the booking page: ${bookingUrl}

## CRITICAL: No Direct Booking
**You cannot book appointments through this email channel.** If someone asks to book, requests specific times, or tries to schedule a session via email:

1. Acknowledge their request warmly
2. Explain that booking is done through our website for the best experience
3. Provide the booking link: ${bookingUrl}
4. Let them know they can choose their preferred therapist and time there

Example responses for booking requests:
- "I'd love to help you book! To see all available therapists and times, please visit ${bookingUrl} - you can choose the perfect slot for you there."
- "Great that you're ready to book! Head over to ${bookingUrl} where you can browse our therapists and pick a time that works for you."

## Key Information About Spill
- Spill provides professional therapy sessions
- Sessions are typically ${sessionDuration} minutes
- Users can book at their convenience through the web app
- All sessions are confidential

## User Information
- Name: ${userName}

## Guidelines
- Keep responses brief (1-2 paragraphs max)
- Be warm and encouraging without being pushy
- For questions about therapy approaches, specific therapists, or pricing, suggest they explore the booking page or book a session
- **Always** include the booking URL in your response
- Sign off as "${agentName.split(' ')[0]}" or "The Spill Team"

## What You Can Help With
- General questions about Spill's therapy services
- How the booking process works
- What to expect from a session
- Reassurance and encouragement

## What You Cannot Do Here
- Book appointments (direct to website)
- Offer specific therapist availability (direct to website)
- Promise specific times or therapists (direct to website)
- Handle rescheduling or cancellations (direct to website)

## Handling Unsubscribe Requests
If a user asks to unsubscribe, stop receiving emails, or be removed from the mailing list:
1. Use the unsubscribe_user tool with their email address
2. Then send a friendly confirmation email acknowledging their request
3. Be understanding and professional - don't try to convince them to stay

Example unsubscribe response:
"Hi [Name], I've removed you from our mailing list - you won't receive any more promotional emails from us. If you ever change your mind, you can always visit ${bookingUrl} to book a session. Take care!"

## Available Tools
- send_email: Use this to reply to the user's message
- unsubscribe_user: Use this to remove a user from the weekly mailing list when they request it`;
  }
}

// Singleton for callers that don't need per-request tracing (chase-email,
// lifecycle transitions, etc). The traceId is only used for logging inside
// the instance, so a default is fine here.
export const aiConversationService = new AIConversationService('shared');

/**
 * Choose the stage to fall back to when dismissing a closure recommendation
 * whose JSON checkpoint is wedged at `closure_recommended`.
 *
 * Two paths can wedge the JSON at this stage and both lose direct access to
 * the actual prior stage:
 *
 *   1. Chase-recommended (chase-email): prior action was 'sent_chase_followup'
 *      which gets overwritten by 'closure_recommended_to_admin' →
 *      lastSuccessfulAction maps to 'closure_recommended' (uninformative).
 *      The chase path DOES set `chaseSentTo`, so that's the strongest signal.
 *
 *   2. Agent-recommended (recommend_cancel_match): the agent overwrites
 *      lastSuccessfulAction with 'recommended_cancel_match' (also maps to
 *      'closure_recommended', uninformative) and never sets `chaseSentTo`.
 *      Without consulting other state we'd always fall back to
 *      'awaiting_therapist_availability', which is wrong whenever the agent
 *      was actually waiting on the user.
 *
 * Inference order:
 *   a. `lastSuccessfulAction` — works when the prior action wasn't itself a
 *      closure-recommendation action.
 *   b. `checkpoint.context.lastEmailSentTo` — preserved across checkpoint
 *      updates (updateCheckpoint spreads context), so it reflects whoever the
 *      agent was last waiting on regardless of which closure path fired.
 *   c. `chaseSentTo` — only meaningful for the chase-recommended path.
 *   d. Final default — 'awaiting_therapist_availability'.
 *
 * Lives here rather than in the lifecycle service because it's purely
 * about checkpoint state and consumes types from conversation-checkpoint.
 */
export function inferRestoredStage(
  checkpoint: ConversationCheckpoint | null | undefined,
  chaseSentTo: string | null,
): ConversationStage {
  if (checkpoint?.lastSuccessfulAction) {
    const inferred = stageFromAction(checkpoint.lastSuccessfulAction);
    if (inferred !== 'closure_recommended' && inferred !== 'chased') {
      return inferred;
    }
  }

  const lastEmailTo = checkpoint?.context?.lastEmailSentTo;
  if (lastEmailTo === 'user') return 'awaiting_user_slot_selection';
  if (lastEmailTo === 'therapist') return 'awaiting_therapist_availability';

  if (chaseSentTo === 'user') return 'awaiting_user_slot_selection';
  if (chaseSentTo === 'therapist') return 'awaiting_therapist_availability';

  return 'awaiting_therapist_availability';
}
