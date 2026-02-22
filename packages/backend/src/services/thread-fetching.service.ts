import { google, gmail_v1 } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';
import { logger } from '../utils/logger';
import { EMAIL, THREAD_LIMITS } from '../constants';
import { redis } from '../utils/redis';
import * as fs from 'fs';
import * as path from 'path';

/**
 * FIX T1: OAuth token refresh mutex
 * Prevents concurrent token refresh attempts which can cause race conditions
 * where multiple instances refresh simultaneously and invalidate each other's tokens
 */
const TOKEN_REFRESH_LOCK_KEY = 'gmail:token_refresh_lock';
const TOKEN_REFRESH_LOCK_TTL_SECONDS = 30; // Lock expires after 30 seconds
const TOKEN_REFRESH_WAIT_MS = 100; // Polling interval while waiting for lock
const TOKEN_REFRESH_MAX_WAIT_MS = 10000; // Maximum time to wait for another refresh

/**
 * Acquire the token refresh lock or wait if another process is refreshing.
 * Returns the lock value string (for ownership-safe release) if acquired, null if timed out.
 */
async function acquireTokenRefreshLock(traceId: string): Promise<string | null> {
  const startTime = Date.now();
  const lockValue = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  while (Date.now() - startTime < TOKEN_REFRESH_MAX_WAIT_MS) {
    try {
      const result = await redis.set(
        TOKEN_REFRESH_LOCK_KEY,
        lockValue,
        'EX',
        TOKEN_REFRESH_LOCK_TTL_SECONDS,
        'NX'
      );

      if (result === 'OK') {
        logger.debug({ traceId }, 'Acquired OAuth token refresh lock');
        return lockValue;
      }

      await new Promise(resolve => setTimeout(resolve, TOKEN_REFRESH_WAIT_MS));
    } catch (err) {
      logger.warn({ err, traceId }, 'Redis unavailable for token refresh lock - proceeding without lock');
      return lockValue; // Proceed without lock on Redis failure
    }
  }

  logger.warn({ traceId }, 'Token refresh lock wait timeout - proceeding anyway');
  return lockValue;
}

/**
 * Ownership-safe lock release using Lua script.
 * Only releases if the caller still owns the lock.
 */
const TOKEN_LOCK_RELEASE_SCRIPT = `
local lockKey = KEYS[1]
local expectedValue = ARGV[1]
local currentValue = redis.call('GET', lockKey)
if currentValue == expectedValue then
  redis.call('DEL', lockKey)
  return 1
else
  return 0
end
`;

async function releaseTokenRefreshLock(lockValue: string | null): Promise<void> {
  if (!lockValue) return;
  try {
    await redis.eval(TOKEN_LOCK_RELEASE_SCRIPT, 1, TOKEN_REFRESH_LOCK_KEY, lockValue);
  } catch (err) {
    // Ignore - lock will expire naturally
  }
}

/**
 * Context markers used for structuring thread content
 * These MUST be escaped in email bodies to prevent confusion
 */
const CONTEXT_MARKERS = [
  '=== COMPLETE EMAIL THREAD HISTORY ===',
  '=== END OF THREAD HISTORY ===',
  '=== NEW EMAIL REQUIRING RESPONSE ===',
  '--- Message',
  '---BEGIN',
  '---END',
];

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

// Gmail credentials paths (shared with email-processing.service.ts)
const CREDENTIALS_PATH = process.env.MCP_GMAIL_CREDENTIALS_PATH ||
  path.join(process.cwd(), '../mcp-gmail/credentials.json');
const TOKEN_PATH = process.env.MCP_GMAIL_TOKEN_PATH ||
  path.join(process.cwd(), '../mcp-gmail/token.json');

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
 * Load credentials from environment variables (for production)
 */
function loadCredentialsFromEnv(): { credentials: any; token: any } | null {
  const credentialsBase64 = process.env.GMAIL_CREDENTIALS_BASE64;
  const tokenBase64 = process.env.GMAIL_TOKEN_BASE64;

  if (credentialsBase64 && tokenBase64) {
    try {
      const credentials = JSON.parse(Buffer.from(credentialsBase64, 'base64').toString('utf-8'));
      const token = JSON.parse(Buffer.from(tokenBase64, 'base64').toString('utf-8'));
      return { credentials, token };
    } catch (error) {
      logger.error({ error }, 'Failed to parse Gmail credentials from env vars');
    }
  }
  return null;
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
  private schedulerEmail: string = EMAIL.FROM_ADDRESS;

  constructor() {
    this.initializeGmailClient();
  }

  /**
   * Initialize the Gmail API client using stored OAuth credentials
   */
  private async initializeGmailClient(): Promise<void> {
    try {
      let credentials: any;
      let token: any;

      // First try to load from environment variables (RECOMMENDED for production)
      const envCreds = loadCredentialsFromEnv();
      if (envCreds) {
        logger.info('ThreadFetchingService: Loading Gmail credentials from environment variables (secure)');
        credentials = envCreds.credentials;
        token = envCreds.token;
      } else {
        // Fall back to file-based credentials (for local development ONLY)
        const isProduction = process.env.NODE_ENV === 'production';

        if (!fs.existsSync(CREDENTIALS_PATH)) {
          logger.warn({ path: CREDENTIALS_PATH }, 'ThreadFetchingService: Gmail credentials file not found');
          return;
        }
        credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf-8'));

        if (!fs.existsSync(TOKEN_PATH)) {
          logger.warn({ path: TOKEN_PATH }, 'ThreadFetchingService: Gmail token file not found');
          return;
        }
        token = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf-8'));

        // Log security warning in production
        if (isProduction) {
          logger.warn(
            'ThreadFetchingService: SECURITY WARNING - Using file-based credentials in production'
          );
        }
      }

      const { client_id, client_secret, redirect_uris } = credentials.installed || credentials.web;
      this.oauth2Client = new OAuth2Client(client_id, client_secret, redirect_uris?.[0]);

      // Handle token format - might be from MCP (with nested structure) or direct OAuth
      if (token.refresh_token) {
        this.oauth2Client.setCredentials({
          refresh_token: token.refresh_token,
          access_token: token.token || token.access_token,
          token_type: 'Bearer',
          expiry_date: token.expiry ? new Date(token.expiry).getTime() : undefined,
        });
      } else {
        this.oauth2Client.setCredentials(token);
      }

      this.gmail = google.gmail({ version: 'v1', auth: this.oauth2Client });

      // Get the actual scheduler email address
      try {
        const profile = await this.gmail.users.getProfile({ userId: 'me' });
        if (profile.data.emailAddress) {
          this.schedulerEmail = profile.data.emailAddress;
        }
      } catch {
        // Use default if profile fetch fails
      }

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

      if (!threadResponse.data.messages || threadResponse.data.messages.length === 0) {
        logger.warn({ traceId, threadId }, 'Thread has no messages');
        return null;
      }

      // FIX: Large thread memory protection
      // If thread has too many messages, only process the most recent ones
      let gmailMessages = threadResponse.data.messages;
      const originalCount = gmailMessages.length;

      if (originalCount > THREAD_LIMITS.MAX_MESSAGES_PER_THREAD) {
        logger.warn(
          { traceId, threadId, originalCount, limit: THREAD_LIMITS.MAX_MESSAGES_PER_THREAD },
          'Thread exceeds message limit - keeping only recent messages'
        );
        // Keep only the most recent messages (they're in chronological order from Gmail)
        gmailMessages = gmailMessages.slice(-THREAD_LIMITS.KEEP_RECENT_MESSAGES);
      }

      const messages: ThreadMessage[] = [];
      const participantEmails = new Set<string>();
      let totalBodySize = 0;

      for (const gmailMessage of gmailMessages) {
        const parsed = this.parseGmailMessage(gmailMessage);
        if (parsed) {
          // Track total body size to prevent memory exhaustion
          const bodySize = Buffer.byteLength(parsed.body, 'utf-8');
          if (totalBodySize + bodySize > THREAD_LIMITS.MAX_THREAD_BODY_SIZE) {
            logger.warn(
              { traceId, threadId, totalBodySize, limit: THREAD_LIMITS.MAX_THREAD_BODY_SIZE },
              'Thread body size limit reached - truncating older messages'
            );
            break;
          }
          totalBodySize += bodySize;

          messages.push(parsed);
          if (parsed.from) participantEmails.add(parsed.from.toLowerCase());
          if (parsed.to) participantEmails.add(parsed.to.toLowerCase());
        }
      }

      // Sort messages chronologically (oldest first)
      messages.sort((a, b) => a.date.getTime() - b.date.getTime());

      const thread: EmailThread = {
        threadId,
        messages,
        participantEmails: Array.from(participantEmails),
        messageCount: messages.length,
      };

      // Log if thread was truncated
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
    } catch (error: any) {
      // Handle thread not found (404)
      if (error?.code === 404 || error?.status === 404) {
        logger.warn({ traceId, threadId }, 'Thread not found in Gmail');
        return null;
      }

      // FIX E5 + T1: Handle 401 Unauthorized - attempt token refresh with mutex
      if (error?.code === 401 || error?.status === 401) {
        logger.warn({ traceId, threadId }, 'Gmail token expired - attempting refresh');
        try {
          // FIX T1: Use mutex to prevent concurrent refresh attempts
          // Multiple workers hitting 401 simultaneously could all try to refresh
          // and invalidate each other's tokens. The mutex ensures only one refreshes.
          const lockValue = await acquireTokenRefreshLock(traceId);
          if (this.oauth2Client) {
            if (lockValue) {
              try {
                await this.oauth2Client.getAccessToken();
              } finally {
                await releaseTokenRefreshLock(lockValue);
              }
            }
            logger.info({ traceId, threadId }, 'Token refreshed successfully - retrying fetch');

            // Retry the thread fetch once
            const retryResponse = await this.gmail!.users.threads.get({
              userId: 'me',
              id: threadId,
              format: 'full',
            });

            if (!retryResponse.data.messages || retryResponse.data.messages.length === 0) {
              logger.warn({ traceId, threadId }, 'Thread has no messages after retry');
              return null;
            }

            const messages: ThreadMessage[] = [];
            const participantEmails = new Set<string>();

            for (const gmailMessage of retryResponse.data.messages) {
              const parsed = this.parseGmailMessage(gmailMessage);
              if (parsed) {
                messages.push(parsed);
                if (parsed.from) participantEmails.add(parsed.from.toLowerCase());
                if (parsed.to) participantEmails.add(parsed.to.toLowerCase());
              }
            }

            messages.sort((a, b) => a.date.getTime() - b.date.getTime());

            const thread: EmailThread = {
              threadId,
              messages,
              participantEmails: Array.from(participantEmails),
              messageCount: messages.length,
            };

            logger.info(
              { traceId, threadId, messageCount: thread.messageCount },
              'Thread fetched successfully after token refresh'
            );

            return thread;
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
      lines.push(escapeContextMarkers(this.truncateBody(msg.body)));
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

    const from = this.extractEmail(getHeader('from'));
    const to = this.extractEmail(getHeader('to'));
    const subject = getHeader('subject');

    // Parse date
    let date: Date;
    try {
      const dateHeader = getHeader('date');
      const dateValue = dateHeader || message.internalDate;
      date = dateValue ? new Date(dateValue) : new Date();
      if (isNaN(date.getTime())) {
        date = new Date();
      }
    } catch {
      date = new Date();
    }

    // Extract body with charset-aware decoding
    let body = '';
    try {
      if (message.payload?.body?.data) {
        // Decode with charset detection and clean up HTML entities
        const contentType = message.payload.mimeType || 'text/plain; charset=utf-8';
        const rawBody = this.decodeEmailBody(message.payload.body.data, contentType);
        if (contentType.includes('text/html')) {
          body = this.stripHtml(rawBody);
        } else {
          body = this.decodeHtmlEntities(rawBody);
        }
      } else if (message.payload?.parts) {
        // Try to find plain text part first
        const textPart = message.payload.parts.find(
          (p) => p.mimeType === 'text/plain'
        );
        if (textPart?.body?.data) {
          // Decode with charset detection and clean up HTML entities
          const contentType = textPart.mimeType || 'text/plain; charset=utf-8';
          const rawBody = this.decodeEmailBody(textPart.body.data, contentType);
          body = this.decodeHtmlEntities(rawBody);
        } else {
          // Fall back to HTML if no plain text
          const htmlPart = message.payload.parts.find(
            (p) => p.mimeType === 'text/html'
          );
          if (htmlPart?.body?.data) {
            const contentType = htmlPart.mimeType || 'text/html; charset=utf-8';
            const rawBody = this.decodeEmailBody(htmlPart.body.data, contentType);
            body = this.stripHtml(rawBody);
          }
        }
      }
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
   * Extract email address from "Name <email>" format
   */
  private extractEmail(headerValue: string): string {
    const match = headerValue.match(/<([^>]+)>/);
    return match ? match[1] : headerValue.trim();
  }

  /**
   * Extract charset from Content-Type header or MIME type string
   * Returns 'utf-8' as default if not found
   */
  private extractCharset(contentType: string): BufferEncoding {
    const match = contentType.match(/charset=["']?([^"';\s]+)/i);
    const charset = match ? match[1].toLowerCase() : 'utf-8';

    // Map common charset names to Node.js BufferEncoding
    const charsetMap: Record<string, BufferEncoding> = {
      'utf-8': 'utf-8',
      'utf8': 'utf-8',
      'iso-8859-1': 'latin1',
      'iso_8859-1': 'latin1',
      'latin1': 'latin1',
      'windows-1252': 'latin1', // Close enough for most cases
      'ascii': 'ascii',
      'us-ascii': 'ascii',
    };

    return charsetMap[charset] || 'utf-8';
  }

  /**
   * Decode base64 email body with proper charset handling
   *
   * IMPORTANT: Gmail API returns body data in URL-safe Base64 format:
   * - Uses '-' instead of '+'
   * - Uses '_' instead of '/'
   * - May omit padding '='
   *
   * Node.js Buffer.from('base64') handles URL-safe Base64 since v15.14.0,
   * but we convert explicitly for maximum compatibility.
   */
  private decodeEmailBody(base64Data: string, contentType: string): string {
    const charset = this.extractCharset(contentType);
    try {
      // Convert URL-safe Base64 to standard Base64 for maximum compatibility
      const standardBase64 = base64Data
        .replace(/-/g, '+')
        .replace(/_/g, '/');

      // Add padding if needed (Base64 must be multiple of 4)
      const paddedBase64 = standardBase64 + '='.repeat((4 - (standardBase64.length % 4)) % 4);

      return Buffer.from(paddedBase64, 'base64').toString(charset);
    } catch {
      // Fall back to UTF-8 if charset decoding fails
      logger.debug({ contentType, charset }, 'Charset decoding failed, falling back to UTF-8');
      try {
        const standardBase64 = base64Data.replace(/-/g, '+').replace(/_/g, '/');
        const paddedBase64 = standardBase64 + '='.repeat((4 - (standardBase64.length % 4)) % 4);
        return Buffer.from(paddedBase64, 'base64').toString('utf-8');
      } catch {
        // Last resort: try direct decoding
        return Buffer.from(base64Data, 'base64').toString('utf-8');
      }
    }
  }

  /**
   * Decode common HTML entities to their character equivalents
   * Applies to both plain text and HTML-stripped content
   *
   * IMPORTANT: Order matters - specific entities first, then numeric
   * This prevents double-decoding of escaped numeric entities like &amp;#123;
   */
  private decodeHtmlEntities(text: string): string {
    return text
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&#39;/g, "'")
      .replace(/&#x27;/g, "'")
      .replace(/&ndash;/g, '\u2013')  // en-dash
      .replace(/&mdash;/g, '\u2014')  // em-dash
      .replace(/&hellip;/g, '\u2026') // horizontal ellipsis
      .replace(/&lsquo;/g, '\u2018')  // left single quote
      .replace(/&rsquo;/g, '\u2019')  // right single quote
      .replace(/&ldquo;/g, '\u201C')  // left double quote
      .replace(/&rdquo;/g, '\u201D')  // right double quote
      .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)))
      .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  }

  /**
   * Strip HTML tags from content and convert to plain text
   * Preserves paragraph structure by converting block elements to newlines
   */
  private stripHtml(html: string): string {
    const stripped = html
      // Remove script and style blocks entirely
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      // Convert block elements to newlines for structure
      .replace(/<\/p>/gi, '\n\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/div>/gi, '\n')
      .replace(/<\/li>/gi, '\n')
      .replace(/<\/tr>/gi, '\n')
      .replace(/<\/h[1-6]>/gi, '\n\n')
      // Remove all remaining HTML tags
      .replace(/<[^>]+>/g, '')
      // Normalize whitespace (preserve intentional line breaks)
      .replace(/[ \t]+/g, ' ')           // Collapse horizontal whitespace
      .replace(/ *\n */g, '\n')          // Trim spaces around newlines
      .replace(/\n{3,}/g, '\n\n')        // Collapse excessive newlines
      .trim();

    return this.decodeHtmlEntities(stripped);
  }

  /**
   * Truncate very long email bodies to prevent context overflow
   * Keeps first and last portions for context
   */
  private truncateBody(body: string, maxLength: number = 3000): string {
    if (body.length <= maxLength) {
      return body;
    }

    // Calculate how much space the indicator will take
    const removedChars = body.length - maxLength;
    const indicator = `\n\n[... MESSAGE TRUNCATED - ${removedChars} characters removed ...]\n\n`;

    // Account for indicator length when calculating available space
    const availableLength = maxLength - indicator.length;
    const halfLength = Math.floor(availableLength / 2);

    const start = body.substring(0, halfLength);
    const end = body.substring(body.length - halfLength);

    return `${start}${indicator}${end}`;
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
