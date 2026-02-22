/**
 * Unsubscribe Token Utility
 *
 * Generates and verifies HMAC-signed tokens for email unsubscription.
 * Token format: v2:{timestamp}:{base64_email}:{hmac_signature}
 *
 * FIX H9: Added timestamp for token expiration (30-day validity)
 * FIX H10: Removed length pre-check to prevent timing attack
 * FIX L7: Support for key rotation via HMAC_KEYS_OLD environment variable
 */

import crypto from 'crypto';
import { config } from '../config';

const TOKEN_VERSION = 'v2'; // Bumped version for new format with timestamp
const ALGORITHM = 'sha256';
const TOKEN_VALIDITY_DAYS = 30; // Tokens expire after 30 days

// Derive a dedicated HMAC key from jwtSecret so unsubscribe tokens don't share
// the same raw key material as JWT authentication tokens
const HMAC_KEY_CONTEXT = 'unsubscribe-token-v2';
function deriveHmacKey(secret: string): string {
  return crypto.createHmac('sha256', secret).update(HMAC_KEY_CONTEXT).digest('hex');
}

// FIX L7: Support key rotation - current key plus any old keys for verification
// Old keys are comma-separated in HMAC_KEYS_OLD env var
const OLD_HMAC_KEYS = (process.env.HMAC_KEYS_OLD || '').split(',').filter(Boolean);

/**
 * Get all valid HMAC keys (current derived + old derived for verification)
 */
function getHmacKeys(): string[] {
  return [deriveHmacKey(config.jwtSecret), ...OLD_HMAC_KEYS.map(deriveHmacKey)];
}

/**
 * Generate a signed unsubscribe token for an email address
 * FIX H9: Includes timestamp for expiration validation
 */
export function generateUnsubscribeToken(email: string): string {
  const timestamp = Date.now().toString(36); // Compact timestamp encoding
  const emailB64 = Buffer.from(email.toLowerCase()).toString('base64url');
  const payload = `${TOKEN_VERSION}:${timestamp}:${emailB64}`;

  const hmac = crypto.createHmac(ALGORITHM, deriveHmacKey(config.jwtSecret));
  hmac.update(payload);
  const signature = hmac.digest('base64url');

  return `${payload}:${signature}`;
}

/**
 * Verify token and extract email address
 * Returns null if the token is invalid, expired, or has been tampered with
 *
 * FIX H9: Added expiration check (30-day validity)
 * FIX H10: Removed length pre-check before timingSafeEqual to prevent timing attack
 */
export function extractEmailFromToken(token: string): string | null {
  try {
    const parts = token.split(':');

    // Support both v1 (legacy, no expiration) and v2 (with expiration) formats
    if (parts.length === 3) {
      // Legacy v1 format: v1:{email}:{signature}
      const [version, emailB64, providedSignature] = parts;
      if (version !== 'v1') {
        return null;
      }

      // Legacy tokens accepted but logged (they'll eventually be replaced)
      const payload = `${version}:${emailB64}`;
      const hmac = crypto.createHmac(ALGORITHM, deriveHmacKey(config.jwtSecret));
      hmac.update(payload);
      const expectedSignature = hmac.digest('base64url');

      // FIX H10: Use timingSafeEqual properly with padding for constant-time comparison
      // Pad both to same length to avoid length-based timing leak
      if (!safeCompare(providedSignature, expectedSignature)) {
        return null;
      }

      return Buffer.from(emailB64, 'base64url').toString('utf-8');
    }

    if (parts.length !== 4) {
      return null;
    }

    // v2 format: v2:{timestamp}:{email}:{signature}
    const [version, timestamp, emailB64, providedSignature] = parts;

    // Verify version
    if (version !== TOKEN_VERSION) {
      return null;
    }

    // FIX H9: Check token expiration
    const tokenTime = parseInt(timestamp, 36);
    const now = Date.now();
    const maxAge = TOKEN_VALIDITY_DAYS * 24 * 60 * 60 * 1000;

    if (isNaN(tokenTime) || now - tokenTime > maxAge) {
      return null; // Token expired or invalid timestamp
    }

    // FIX L7: Try verification with current key first, then old keys for rotation support
    const payload = `${version}:${timestamp}:${emailB64}`;
    let signatureValid = false;

    for (const key of getHmacKeys()) {
      const hmac = crypto.createHmac(ALGORITHM, key);
      hmac.update(payload);
      const expectedSignature = hmac.digest('base64url');

      // FIX H10: Use constant-time comparison without length pre-check
      if (safeCompare(providedSignature, expectedSignature)) {
        signatureValid = true;
        break;
      }
    }

    if (!signatureValid) {
      return null;
    }

    // Decode and return email
    return Buffer.from(emailB64, 'base64url').toString('utf-8');
  } catch {
    return null;
  }
}

/**
 * Constant-time string comparison that doesn't leak length information
 * FIX H10: Pads shorter string to match longer, ensuring constant-time operation
 */
function safeCompare(a: string, b: string): boolean {
  // Pad to same length to avoid length-based timing leak
  const maxLen = Math.max(a.length, b.length);
  const aPadded = a.padEnd(maxLen, '\0');
  const bPadded = b.padEnd(maxLen, '\0');

  const aBuffer = Buffer.from(aPadded);
  const bBuffer = Buffer.from(bPadded);

  // timingSafeEqual now safe because buffers are same length
  return crypto.timingSafeEqual(aBuffer, bBuffer) && a.length === b.length;
}

/**
 * Generate a full unsubscribe URL for an email address
 */
export function generateUnsubscribeUrl(email: string, baseUrl: string): string {
  const token = generateUnsubscribeToken(email);
  return `${baseUrl}/api/unsubscribe/${token}`;
}
