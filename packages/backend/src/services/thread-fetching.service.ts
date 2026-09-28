import { google, gmail_v1 } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';
import { logger } from '../utils/logger';
import { EMAIL, THREAD_LIMITS, TIMEOUTS } from '../constants';
import { truncateText } from '../utils/email-encoding';
import {
  extractEmail,
  extractBodyFromPayload,
  resolveMessageDate,
} from '../utils/email-mime-parser';
import {
  loadGmailCredentials,
  createOAuth2Client,
  acquireTokenRefreshLock,
  releaseTokenRefreshLock,
  refreshAccessToken,
} from '../utils/gmail-auth';
import { isGmail404 } from '../utils/gmail-errors';
import { stripQuotedReply } from '../core/email/inbound/quoted-text';

/**
 * Escape context markers in email content to prevent AI confusion
 * Replaces markers with visually similar but distinct text
 *
 * @param content - The email body content
 * @returns Escaped content with markers replaced
 */
function escapeContextMarkers(content: string): string {
  let escaped = content;

  // Escape the main section markers by adding invisible text or modifying slightly
  // We use Unicode zero-width characters to make them visually similar but not identical
  escaped = escaped.replace(/={3,}\s*(COMPLETE EMAIL THREAD HISTORY|END OF THREAD HISTORY|NEW EMAIL REQUIRING RESPONSE)\s*={3,}/gi,
    (match) => `[quoted: ${match.replace(/=/g, '~')}]`);

  // Escape message delimiter patterns
  escaped = escaped.replace(/---\s*Message\s+\d+/gi,
    (match) => `[quoted: ${match.replace(/-/g, '~')}]`);

  // Escape begin/end content markers (from content-sanitizer.ts wrapUntrustedContent)
  escaped = escaped.replace(/---\s*(BEGIN|END)\s+\w+\s+CONTENT\s*---/gi,
    (match) => `[quoted: ${match.replace(/-/g, '~')}]`);

  return escaped;
}

/**
 * Represents a single email message in a thread
 */
export interface ThreadMessage {
  id: string;
  from: string;
  to: string;
  subject: string;
  body: string;
  date: Date;
  isFromScheduler: boolean;
}

/**
 * Represents a complete email thread with all messages
 */
export interface EmailThread {
  threadId: string;
  messages: ThreadMessage[];
  participantEmails: string[];
  messageCount: number;
}

/**
 * Service for fetching complete email thread history from Gmail
 *
 * This service ensures the AI agent has full context of all messages
 * in a conversation thread before responding.
 */
export class ThreadFetchingService {
  private gmail: gmail_v1.Gmail | null = null;
  private oauth2Client: OAuth2Client | null = null;
  // Single source of truth for "our address" (EMAIL_FROM_ADDRESS). The
  // Gmail profile used to override it here, so the thread labels, the
  // own-mail skip and divergence detection could each disagree about who
  // "we" are; a profile mismatch is now a boot-time warning instead
  // (emailOAuthService.verifySchedulerAddress).
  private readonly schedulerEmail: string = EMAIL.FROM_ADDRESS;

  constructor() {
    this.initializeGmailClient();
  }

  /**
   * Initialize the Gmail API client using stored OAuth credentials
   */
  private async initializeGmailClient(): Promise<void> {
    try {
      const creds = loadGmailCredentials('ThreadFetchingService');
      if (!creds) return;

      this.oauth2Client = createOAuth2Client(creds.credentials, creds.token);
      // Explicit timeout: gaxios has none by default, and a hung thread
      // fetch inside inbound processing held the message lock (renewed
      // forever) and stalled the backup poller until restart.
      this.gmail = google.gmail({ version: 'v1', auth: this.oauth2Client, timeout: TIMEOUTS.GMAIL_API_MS });

      logger.info({ schedulerEmail: this.schedulerEmail }, 'ThreadFetchingService: Gmail client initialized');
    } catch (error) {
      logger.error({ error }, 'ThreadFetchingService: Failed to initialize Gmail client');
    }
  }

  /**
   * Ensure Gmail client is initialized
   */
  private async ensureInitialized(): Promise<void> {
    if (!this.gmail) {
      await this.initializeGmailClient();
      if (!this.gmail) {
        throw new Error('Gmail client not initialized');
      }
    }
  }

  /**
   * Fetch complete thread history by thread ID
   *
   * @param threadId - Gmail thread ID
   * @param traceId - Trace ID for logging
   * @returns Complete thread with all messages in chronological order
   */
  async fetchThreadById(threadId: string, traceId: string): Promise<EmailThread | null> {
    await this.ensureInitialized();

    try {
      logger.info({ traceId, threadId }, 'Fetching complete thread history');

      const threadResponse = await this.gmail!.users.threads.get({
        userId: 'me',
        id: threadId,
        format: 'full',
      });

      return this.processGmailThread(threadId, traceId, threadResponse.data.messages || []);
    } catch (error: any) {
      // Handle thread not found (404)
      if (isGmail404(error)) {
        logger.warn({ traceId, threadId }, 'Thread not found in Gmail');
        return null;
      }

      // FIX E5 + T1: Handle 401 Unauthorized - attempt token refresh with mutex
      if (error?.code === 401 || error?.status === 401) {
        logger.warn({ traceId, threadId }, 'Gmail token expired - attempting refresh');
        try {
          const lockValue = await acquireTokenRefreshLock(traceId);
          if (this.oauth2Client) {
            if (lockValue) {
              try {
                await refreshAccessToken(this.oauth2Client, 'thread-fetch-token-refresh');
              } finally {
                await releaseTokenRefreshLock(lockValue);
              }
            }
            logger.info({ traceId, threadId }, 'Token refreshed successfully - retrying fetch');

            const retryResponse = await this.gmail!.users.threads.get({
              userId: 'me',
              id: threadId,
              format: 'full',
            });

            return this.processGmailThread(threadId, traceId, retryResponse.data.messages || []);
          }
        } catch (refreshError) {
          logger.error(
            { traceId, threadId, error: refreshError },
            'Token refresh failed - requires reauthorization'
          );
          throw new Error('Gmail token refresh failed - requires reauthorization');
        }
      }

      // Handle 403 Forbidden
      if (error?.code === 403 || error?.status === 403) {
        logger.error(
          { traceId, threadId, error },
          'Gmail permission denied - check OAuth scopes'
        );
        throw new Error('Gmail permission denied - insufficient OAuth scopes');
      }

      logger.error({ error, traceId, threadId }, 'Failed to fetch thread');
      throw error;
    }
  }

  /**
   * Process raw Gmail messages into an EmailThread with memory protection.
   *
   * Applies MAX_MESSAGES_PER_THREAD and MAX_THREAD_BODY_SIZE limits consistently.
   * Previously, the 401-retry code path skipped these limits, risking memory
   * exhaustion on large threads after a token refresh.
   */
  private processGmailThread(
    threadId: string,
    traceId: string,
    rawMessages: gmail_v1.Schema$Message[]
  ): EmailThread | null {
    if (rawMessages.length === 0) {
      logger.warn({ traceId, threadId }, 'Thread has no messages');
      return null;
    }

    // Large thread memory protection: cap message count (Gmail returns a
    // thread's messages oldest first, so the tail is the newest).
    let gmailMessages = rawMessages;
    const originalCount = gmailMessages.length;

    if (originalCount > THREAD_LIMITS.MAX_MESSAGES_PER_THREAD) {
      logger.warn(
        { traceId, threadId, originalCount, limit: THREAD_LIMITS.MAX_MESSAGES_PER_THREAD },
        'Thread exceeds message limit - keeping only recent messages'
      );
      gmailMessages = gmailMessages.slice(-THREAD_LIMITS.KEEP_RECENT_MESSAGES);
    }

    const parsedMessages: ThreadMessage[] = [];
    for (const gmailMessage of gmailMessages) {
      const parsed = this.parseGmailMessage(gmailMessage);
      if (parsed) parsedMessages.push(parsed);
    }

    // Sort messages chronologically (oldest first)
    parsedMessages.sort((a, b) => a.date.getTime() - b.date.getTime());

    // Body-size budget, spent NEWEST first: when a thread is too big it is
    // the oldest messages that are dropped, never the latest replies the
    // agent is answering. (This loop used to walk oldest-first and stop at
    // the limit, silently discarding the newest messages.) The newest
    // message is always kept.
    const kept: ThreadMessage[] = [];
    let totalBodySize = 0;
    for (let i = parsedMessages.length - 1; i >= 0; i--) {
      const bodySize = Buffer.byteLength(parsedMessages[i].body, 'utf-8');
      if (kept.length > 0 && totalBodySize + bodySize > THREAD_LIMITS.MAX_THREAD_BODY_SIZE) {
        logger.warn(
          { traceId, threadId, totalBodySize, limit: THREAD_LIMITS.MAX_THREAD_BODY_SIZE, dropped: i + 1 },
          'Thread body size limit reached - dropping older messages'
        );
        break;
      }
      totalBodySize += bodySize;
      kept.push(parsedMessages[i]);
    }
    const messages = kept.reverse();

    const participantEmails = new Set<string>();
    for (const message of messages) {
      if (message.from) participantEmails.add(message.from.toLowerCase());
      if (message.to) participantEmails.add(message.to.toLowerCase());
    }

    const thread: EmailThread = {
      threadId,
      messages,
      participantEmails: Array.from(participantEmails),
      messageCount: messages.length,
    };

    if (originalCount > messages.length) {
      logger.info(
        { traceId, threadId, originalCount, processedCount: messages.length },
        'Thread was truncated to prevent memory issues'
      );
    }

    logger.info(
      { traceId, threadId, messageCount: thread.messageCount, participants: thread.participantEmails },
      'Thread history fetched successfully'
    );

    return thread;
  }

  /**
   * Format thread history as a structured context string for the AI agent
   *
   * This creates a clear, chronological summary of all messages in the thread
   * that the agent can reference when formulating its response.
   *
   * @param thread - The complete email thread
   * @param userEmail - The client's email address
   * @param therapistEmail - The therapist's email address
   * @returns Formatted string with complete thread context
   */
  formatThreadForAgent(
    thread: EmailThread,
    userEmail: string,
    therapistEmail: string
  ): string {
    if (!thread || thread.messages.length === 0) {
      return 'No previous messages in this thread.';
    }

    const lines: string[] = [
      '=== COMPLETE EMAIL THREAD HISTORY ===',
      `Thread ID: ${thread.threadId}`,
      `Total messages: ${thread.messageCount}`,
      '',
      'Messages in chronological order:',
      '',
    ];

    for (let i = 0; i < thread.messages.length; i++) {
      const msg = thread.messages[i];
      const messageNum = i + 1;

      // Determine sender type for clarity
      let senderLabel: string;
      const fromLower = msg.from.toLowerCase();
      if (msg.isFromScheduler || fromLower === this.schedulerEmail.toLowerCase()) {
        senderLabel = 'Justin Time (You/Scheduler)';
      } else if (fromLower === userEmail.toLowerCase()) {
        senderLabel = 'Client';
      } else if (fromLower === therapistEmail.toLowerCase()) {
        senderLabel = 'Therapist';
      } else {
        senderLabel = 'Unknown';
      }

      lines.push(`--- Message ${messageNum} of ${thread.messageCount} ---`);
      lines.push(`From: ${senderLabel} <${msg.from}>`);
      lines.push(`To: ${msg.to}`);
      lines.push(`Date: ${msg.date.toISOString()}`);
      // Escape subject in case it contains markers
      lines.push(`Subject: ${escapeContextMarkers(msg.subject)}`);
      lines.push('');
      // Escape body content to prevent context marker confusion
      lines.push(escapeContextMarkers(truncateText(msg.body)));
      lines.push('');
    }

    lines.push('=== END OF THREAD HISTORY ===');

    return lines.join('\n');
  }

  /**
   * Parse a Gmail API message into our ThreadMessage format
   */
  private parseGmailMessage(message: gmail_v1.Schema$Message): ThreadMessage | null {
    if (!message || !message.id) {
      return null;
    }

    const headers = message.payload?.headers || [];
    const getHeader = (name: string): string =>
      headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value || '';

    const from = extractEmail(getHeader('from'));
    const to = extractEmail(getHeader('to'));
    const subject = getHeader('subject');

    // Date header, falling back to Gmail's internalDate (epoch-ms string —
    // `new Date(internalDate)` on the raw string is always Invalid Date).
    const date = resolveMessageDate(getHeader('date'), message.internalDate);

    // Extract body — shared with parseEmailMessage so the thread context
    // and the inbound message agree. Walks the full MIME tree (replies with
    // attachments / inline signature images nest the text parts) and
    // decodes each part with the charset from its Content-Type header.
    // Quoted history is stripped: every quoted message is already its own
    // entry in the thread context.
    let body = '';
    try {
      body = stripQuotedReply(extractBodyFromPayload(message.payload).body);
    } catch (err) {
      logger.warn({ messageId: message.id, err }, 'Failed to decode message body');
      body = '[Unable to decode message body]';
    }

    // Check if this message is from the scheduler
    const isFromScheduler = from.toLowerCase() === this.schedulerEmail.toLowerCase();

    return {
      id: message.id,
      from,
      to,
      subject,
      body,
      date,
      isFromScheduler,
    };
  }

  /**
   * Check if the service is healthy and can connect to Gmail
   */
  async checkHealth(): Promise<{
    initialized: boolean;
    canConnect: boolean;
    schedulerEmail?: string;
  }> {
    let canConnect = false;
    let schedulerEmail: string | undefined;

    if (this.gmail) {
      try {
        const profile = await this.gmail.users.getProfile({ userId: 'me' });
        canConnect = true;
        schedulerEmail = profile.data.emailAddress || undefined;
      } catch {
        canConnect = false;
      }
    }

    return {
      initialized: !!this.gmail,
      canConnect,
      schedulerEmail,
    };
  }
}

// Singleton instance
export const threadFetchingService = new ThreadFetchingService();
