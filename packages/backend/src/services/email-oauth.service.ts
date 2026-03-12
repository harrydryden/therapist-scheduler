import { google, gmail_v1 } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';
import { logger } from '../utils/logger';
import { DEFAULT_TIMEOUTS } from '../utils/timeout';
import { circuitBreakerRegistry, CIRCUIT_BREAKER_CONFIGS } from '../utils/circuit-breaker';
import {
  loadGmailCredentials,
  createOAuth2Client,
  acquireTokenRefreshLock,
  releaseTokenRefreshLock,
} from '../utils/gmail-auth';
import * as fs from 'fs';
import * as path from 'path';
import { withTimeout } from '../utils/timeout';

/**
 * Gmail API Circuit Breaker
 * Protects against cascading failures when Gmail API is degraded or unavailable.
 * - Opens after 5 failures in 60 seconds
 * - Attempts recovery after 30 seconds
 * - Requires 2 successes to close
 */
const gmailCircuitBreaker = circuitBreakerRegistry.getOrCreate(CIRCUIT_BREAKER_CONFIGS.GMAIL_API);

/**
 * Execute a Gmail API call with circuit breaker and timeout protection.
 *
 * All Gmail API calls should go through this wrapper to:
 * 1. Fail fast when Gmail is degraded (circuit breaker OPEN)
 * 2. Prevent hanging requests (timeout)
 * 3. Track failures for automatic recovery detection
 *
 * @param operation - Name of the operation for logging
 * @param fn - The Gmail API function to execute
 * @param timeoutMs - Optional timeout (default: 30s)
 */
export async function executeGmailWithProtection<T>(
  operation: string,
  fn: () => Promise<T>,
  timeoutMs: number = DEFAULT_TIMEOUTS.HTTP_FETCH
): Promise<T> {
  return gmailCircuitBreaker.execute(async () => {
    return withTimeout(fn(), timeoutMs, operation);
  });
}

/**
 * Get Gmail circuit breaker stats for health checks
 */
export function getGmailCircuitStats() {
  return gmailCircuitBreaker.getStats();
}

/**
 * EmailOAuthService — OAuth token management, Gmail API client initialization,
 * Gmail watch setup, and health checks.
 *
 * Owns the Gmail client singleton. Other email services obtain a reference
 * to the Gmail client (and OAuth2 client) via the exported helpers:
 *   getGmailClient(), getOAuth2Client()
 */
export class EmailOAuthService {
  private gmail: gmail_v1.Gmail | null = null;
  private oauth2Client: OAuth2Client | null = null;

  constructor() {
    this.initializeGmailClient();
  }

  // ─── Gmail client access ────────────────────────────────────────────

  /**
   * Ensure the Gmail client is initialized and return it.
   * Consolidates the repeated init-check-throw pattern used across 7+ methods.
   * @throws Error if Gmail client cannot be initialized
   */
  async ensureGmailClient(): Promise<gmail_v1.Gmail> {
    if (!this.gmail) {
      await this.initializeGmailClient();
      if (!this.gmail) {
        throw new Error('Gmail client not initialized');
      }
    }
    return this.gmail;
  }

  /**
   * Return the raw Gmail client reference (may be null if not initialized).
   */
  getGmailClientRaw(): gmail_v1.Gmail | null {
    return this.gmail;
  }

  /**
   * Return the raw OAuth2 client reference (may be null if not initialized).
   */
  getOAuth2ClientRaw(): OAuth2Client | null {
    return this.oauth2Client;
  }

  // ─── Initialization ─────────────────────────────────────────────────

  /**
   * Initialize the Gmail API client using stored OAuth credentials
   */
  private async initializeGmailClient(): Promise<void> {
    try {
      const creds = loadGmailCredentials('EmailOAuthService');
      if (!creds) {
        // Startup validation: warn loudly if credentials unavailable
        const isProduction = process.env.NODE_ENV === 'production';
        const level = isProduction ? 'error' : 'warn';
        logger[level](
          'Gmail client not initialized - email sending and receiving will be disabled. ' +
          'Set GMAIL_CREDENTIALS_BASE64 and GMAIL_TOKEN_BASE64 environment variables.'
        );
        return;
      }

      this.oauth2Client = createOAuth2Client(creds.credentials, creds.token);

      // Configure Gmail client with timeout to prevent hanging requests
      this.gmail = google.gmail({
        version: 'v1',
        auth: this.oauth2Client,
        timeout: DEFAULT_TIMEOUTS.HTTP_FETCH,
        retry: true,
      });
      logger.info('Gmail client initialized with timeout protection');
    } catch (error) {
      logger.error({ error }, 'Failed to initialize Gmail client');

      if (!this.gmail) {
        const isProduction = process.env.NODE_ENV === 'production';
        const level = isProduction ? 'error' : 'warn';
        logger[level](
          'Gmail client not initialized - email sending and receiving will be disabled. ' +
          'Set GMAIL_CREDENTIALS_BASE64 and GMAIL_TOKEN_BASE64 environment variables.'
        );
      }
    }
  }

  // ─── Token management ───────────────────────────────────────────────

  /**
   * Proactively refresh OAuth token if it's close to expiry
   * Call this before critical operations to prevent mid-operation failures
   *
   * @param minValidityMinutes - Minimum minutes of validity required (default: 10)
   * @returns Token status info
   */
  async ensureValidToken(minValidityMinutes: number = 10): Promise<{
    valid: boolean;
    expiresInMinutes?: number;
    refreshed?: boolean;
    error?: string;
  }> {
    if (!this.oauth2Client) {
      return { valid: false, error: 'OAuth client not initialized' };
    }

    try {
      const credentials = this.oauth2Client.credentials;
      const expiryDate = credentials.expiry_date;

      if (!expiryDate) {
        // No expiry date - try to refresh to get one
        logger.warn('No token expiry date - attempting refresh');
        await this.oauth2Client.getAccessToken();
        return { valid: true, refreshed: true };
      }

      const now = Date.now();
      const expiresInMs = expiryDate - now;
      const expiresInMinutes = Math.floor(expiresInMs / 60000);

      // If token expires soon, proactively refresh
      if (expiresInMinutes < minValidityMinutes) {
        logger.info(
          { expiresInMinutes, minValidityMinutes },
          'Token expiring soon - proactively refreshing'
        );

        // Use lock to prevent concurrent refresh attempts
        const lockValue = await acquireTokenRefreshLock('proactive-refresh');
        if (lockValue) {
          try {
            await this.oauth2Client.getAccessToken();
            const newExpiry = this.oauth2Client.credentials.expiry_date;
            const newExpiresIn = newExpiry ? Math.floor((newExpiry - Date.now()) / 60000) : undefined;

            logger.info({ newExpiresInMinutes: newExpiresIn }, 'Token refreshed successfully');
            return { valid: true, expiresInMinutes: newExpiresIn, refreshed: true };
          } finally {
            await releaseTokenRefreshLock(lockValue);
          }
        } else {
          // Another process is refreshing - wait briefly and check again
          await new Promise(resolve => setTimeout(resolve, 500));
          const updatedExpiry = this.oauth2Client.credentials.expiry_date;
          if (updatedExpiry && updatedExpiry - Date.now() > minValidityMinutes * 60000) {
            return { valid: true, expiresInMinutes: Math.floor((updatedExpiry - Date.now()) / 60000), refreshed: true };
          }
        }
      }

      return { valid: true, expiresInMinutes };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error({ error: errorMessage }, 'Failed to ensure valid token');
      return { valid: false, error: errorMessage };
    }
  }

  /**
   * Get token status for health checks
   */
  getTokenStatus(): {
    initialized: boolean;
    hasRefreshToken: boolean;
    expiresInMinutes?: number;
  } {
    if (!this.oauth2Client) {
      return { initialized: false, hasRefreshToken: false };
    }

    const credentials = this.oauth2Client.credentials;
    const hasRefreshToken = !!credentials.refresh_token;
    const expiryDate = credentials.expiry_date;
    const expiresInMinutes = expiryDate
      ? Math.floor((expiryDate - Date.now()) / 60000)
      : undefined;

    return {
      initialized: true,
      hasRefreshToken,
      expiresInMinutes,
    };
  }

  // ─── Push notifications (watch) ─────────────────────────────────────

  /**
   * Set up Gmail push notifications (watch)
   */
  async setupPushNotifications(topicName: string): Promise<{ historyId: string; expiration: string }> {
    const gmail = await this.ensureGmailClient();

    const response = await gmail.users.watch({
      userId: 'me',
      requestBody: {
        topicName,
        labelIds: ['INBOX'],
      },
    });

    const historyId = response.data.historyId || '';
    const expiration = response.data.expiration || '';

    logger.info({ historyId, expiration, topicName }, 'Gmail push notifications set up');

    return { historyId, expiration };
  }

  // ─── Health check ───────────────────────────────────────────────────

  /**
   * Check Gmail integration health
   */
  async checkHealth(): Promise<{
    initialized: boolean;
    credentialsFound: boolean;
    tokenFound: boolean;
    canConnect: boolean;
    emailAddress?: string;
  }> {
    const credentialsPath = process.env.MCP_GMAIL_CREDENTIALS_PATH ||
      path.join(process.cwd(), '../mcp-gmail/credentials.json');
    const tokenPath = process.env.MCP_GMAIL_TOKEN_PATH ||
      path.join(process.cwd(), '../mcp-gmail/token.json');
    const credentialsFound = fs.existsSync(credentialsPath);
    const tokenFound = fs.existsSync(tokenPath);

    let canConnect = false;
    let emailAddress: string | undefined;
    if (this.gmail) {
      try {
        const profile = await this.gmail.users.getProfile({ userId: 'me' });
        canConnect = true;
        emailAddress = profile.data.emailAddress || undefined;
      } catch {
        canConnect = false;
      }
    }

    return {
      initialized: !!this.gmail,
      credentialsFound,
      tokenFound,
      canConnect,
      emailAddress,
    };
  }
}

/** Singleton instance */
export const emailOAuthService = new EmailOAuthService();
