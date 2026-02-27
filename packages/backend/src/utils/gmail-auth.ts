/**
 * Shared Gmail OAuth utilities
 *
 * Extracts duplicated Gmail credential loading and token refresh lock logic
 * previously copied between thread-fetching.service.ts and email-processing.service.ts.
 *
 * Used by: thread-fetching.service, email-processing.service
 */

import { OAuth2Client } from 'google-auth-library';
import { redis } from './redis';
import { logger } from './logger';
import * as fs from 'fs';
import * as path from 'path';

// Gmail credentials paths
const CREDENTIALS_PATH = process.env.MCP_GMAIL_CREDENTIALS_PATH ||
  path.join(process.cwd(), '../mcp-gmail/credentials.json');
const TOKEN_PATH = process.env.MCP_GMAIL_TOKEN_PATH ||
  path.join(process.cwd(), '../mcp-gmail/token.json');

/**
 * OAuth token refresh mutex constants.
 * Prevents concurrent token refresh attempts which can cause race conditions
 * where multiple instances refresh simultaneously and invalidate each other's tokens.
 */
const TOKEN_REFRESH_LOCK_KEY = 'gmail:token_refresh_lock';
const TOKEN_REFRESH_LOCK_TTL_SECONDS = 30;
const TOKEN_REFRESH_WAIT_MS = 100;
const TOKEN_REFRESH_MAX_WAIT_MS = 10000;

/**
 * Lua script for ownership-safe lock release.
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

/**
 * Load Gmail credentials from environment variables (base64-encoded).
 * Returns null if env vars are not set or parsing fails.
 */
export function loadCredentialsFromEnv(): { credentials: any; token: any } | null {
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
 * Load Gmail credentials and token, trying env vars first then falling back to files.
 * Logs security warnings when file-based credentials are used in production.
 */
export function loadGmailCredentials(serviceName: string): { credentials: any; token: any } | null {
  // Try environment variables first (recommended for production)
  const envCreds = loadCredentialsFromEnv();
  if (envCreds) {
    logger.info(`${serviceName}: Loading Gmail credentials from environment variables (secure)`);
    return envCreds;
  }

  // Fall back to file-based credentials (for local development ONLY)
  const isProduction = process.env.NODE_ENV === 'production';

  if (!fs.existsSync(CREDENTIALS_PATH)) {
    logger.warn({ path: CREDENTIALS_PATH }, `${serviceName}: Gmail credentials file not found`);
    return null;
  }
  const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf-8'));

  if (!fs.existsSync(TOKEN_PATH)) {
    logger.warn({ path: TOKEN_PATH }, `${serviceName}: Gmail token file not found`);
    return null;
  }
  const token = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf-8'));

  if (isProduction) {
    logger.warn(
      `${serviceName}: SECURITY WARNING - Using file-based credentials in production`
    );
  }

  return { credentials, token };
}

/**
 * Create and configure an OAuth2Client from credentials and token.
 */
export function createOAuth2Client(credentials: any, token: any): OAuth2Client {
  const { client_id, client_secret, redirect_uris } = credentials.installed || credentials.web;
  const oauth2Client = new OAuth2Client(client_id, client_secret, redirect_uris?.[0]);

  // Handle token format - might be from MCP (with nested structure) or direct OAuth
  if (token.refresh_token) {
    oauth2Client.setCredentials({
      refresh_token: token.refresh_token,
      access_token: token.token || token.access_token,
      token_type: 'Bearer',
      expiry_date: token.expiry ? new Date(token.expiry).getTime() : undefined,
    });
  } else {
    oauth2Client.setCredentials(token);
  }

  return oauth2Client;
}

/**
 * Acquire the token refresh lock or wait if another process is refreshing.
 * Returns the lock value string (for ownership-safe release) if acquired.
 * Returns a lock value even on timeout/failure to avoid deadlocks.
 */
export async function acquireTokenRefreshLock(traceId: string): Promise<string | null> {
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
      return lockValue;
    }
  }

  logger.warn({ traceId }, 'Token refresh lock wait timeout - proceeding anyway');
  return lockValue;
}

/**
 * Ownership-safe lock release. Only releases if the caller still owns the lock.
 */
export async function releaseTokenRefreshLock(lockValue: string | null): Promise<void> {
  if (!lockValue) return;
  try {
    await redis.eval(TOKEN_LOCK_RELEASE_SCRIPT, 1, TOKEN_REFRESH_LOCK_KEY, lockValue);
  } catch {
    // Ignore - lock will expire naturally
  }
}
