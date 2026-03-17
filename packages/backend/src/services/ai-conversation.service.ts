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
import type { ConversationState } from '../types';

import type { ConversationMessage } from './justin-time.service';

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
        // Version mismatch - another process modified the state
        throw new Error(
          `Optimistic locking conflict: conversation state was modified by another process for appointment ${appointmentRequestId}`
        );
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
        const errorMsg = error instanceof Error ? error.message : 'Unknown';

        // Don't retry optimistic locking conflicts - they indicate a real conflict
        if (errorMsg.includes('Optimistic locking conflict')) {
          logger.warn(
            { traceId: this.traceId, appointmentRequestId, attempt },
            'State save conflict - not retrying (concurrent modification)'
          );
          break;
        }

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
   * Trim conversation state to prevent unbounded growth
   * Keeps the most recent messages while preserving conversation coherence
   */
  trimConversationState(
    state: { systemPrompt?: string; messages: ConversationMessage[] }
  ): { systemPrompt?: string; messages: ConversationMessage[] } {
    const { MAX_MESSAGES, TRIM_TO_MESSAGES, MAX_STATE_BYTES } = CONVERSATION_LIMITS;

    // Check if trimming is needed
    if (state.messages.length <= MAX_MESSAGES) {
      // Also check byte size
      const stateSize = JSON.stringify(state).length;
      if (stateSize <= MAX_STATE_BYTES) {
        return state;
      }
    }

    // Trim to TRIM_TO_MESSAGES, keeping most recent
    const trimmedMessages = state.messages.slice(-TRIM_TO_MESSAGES);

    // Add a summary message at the beginning to indicate context was trimmed
    const droppedCount = state.messages.length - TRIM_TO_MESSAGES;
    if (droppedCount > 0) {
      trimmedMessages.unshift({
        role: 'user' as const,
        content: `[System Note: ${droppedCount} older messages were trimmed to maintain performance. Recent context preserved.]`,
      });
    }

    logger.info(
      {
        originalCount: state.messages.length,
        trimmedCount: trimmedMessages.length,
        droppedCount,
      },
      'Trimmed conversation state to prevent unbounded growth'
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
            // Find the user in the Notion database and mark as unsubscribed
            const { notionUsersService } = await import('./notion-users.service');
            const user = await notionUsersService.findUserByEmail(input.email.toLowerCase());

            if (user) {
              await notionUsersService.updateSubscription(user.pageId, false);
              logger.info(
                { traceId: this.traceId, email: input.email, pageId: user.pageId },
                'User unsubscribed from weekly mailing list'
              );
            } else {
              // User not found in database, log but continue
              logger.warn(
                { traceId: this.traceId, email: input.email },
                'User not found in Notion database for unsubscribe, may already be unsubscribed'
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
