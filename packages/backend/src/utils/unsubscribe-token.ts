/**
 * Unsubscribe Token Utility
 *
 * Generates HMAC-signed tokens that prove a recipient asked to
 * unsubscribe from the weekly mailing list. Token format:
 *   `v2:{timestamp_b36}:{base64url_email}:{base64url_signature}`
 *
 * Crypto primitives live in `hmac-token.ts`. The legacy v1 format
 * (`v1:{base64_email}:{signature}`, no timestamp/expiry) is still
 * accepted on the verify path so links from older mailings keep
 * working; new tokens are always v2.
 */

import crypto from 'crypto';
import {
  signTimestampedToken,
  verifyTimestampedToken,
  getHmacKeys,
  safeCompare,
} from './hmac-token';

const TOKEN_VERSION = 'v2';
const HMAC_KEY_CONTEXT = 'unsubscribe-token-v2';
const TOKEN_VALIDITY_DAYS = 30;
const ALGORITHM = 'sha256';

/**
 * Generate a signed unsubscribe token. Always emits v2 (timestamped).
 * Email is normalized to lowercase before signing so case variations
 * verify back to the same address.
 */
export function generateUnsubscribeToken(email: string): string {
  return signTimestampedToken({
    context: HMAC_KEY_CONTEXT,
    version: TOKEN_VERSION,
    payload: email.toLowerCase(),
  });
}

/**
 * Verify an unsubscribe token and extract the email. Accepts both v1
 * (legacy, no expiry) and v2 (current, 30-day expiry).
 *
 * Returns null on malformed input, signature mismatch, version mismatch,
 * or v2 expiry. Legacy v1 tokens are accepted indefinitely so we don't
 * break unsubscribe links from emails sent before v2 shipped.
 */
export function extractEmailFromToken(token: string): string | null {
  try {
    const parts = token.split(':');
    if (parts.length === 3) {
      return verifyLegacyV1Token(parts);
    }
    if (parts.length !== 4) return null;

    const verified = verifyTimestampedToken(token, {
      context: HMAC_KEY_CONTEXT,
      expectedVersion: TOKEN_VERSION,
      validityDays: TOKEN_VALIDITY_DAYS,
    });
    if (!verified || verified.expired) return null;
    return verified.payload;
  } catch {
    return null;
  }
}

/**
 * Legacy v1 parser. Format: `v1:{base64url_email}:{signature}` — no
 * timestamp, no expiry. Kept inline here rather than in hmac-token.ts
 * because the format predates the consolidated 4-part envelope and
 * shouldn't tempt new token types into copying it.
 */
function verifyLegacyV1Token(parts: string[]): string | null {
  const [version, emailB64, providedSignature] = parts;
  if (version !== 'v1') return null;

  const signed = `${version}:${emailB64}`;
  let valid = false;
  for (const key of getHmacKeys(HMAC_KEY_CONTEXT)) {
    const hmac = crypto.createHmac(ALGORITHM, key);
    hmac.update(signed);
    if (safeCompare(providedSignature, hmac.digest('base64url'))) {
      valid = true;
      break;
    }
  }
  if (!valid) return null;

  try {
    return Buffer.from(emailB64, 'base64url').toString('utf-8');
  } catch {
    return null;
  }
}

/** Build the full unsubscribe URL for an email address. */
export function generateUnsubscribeUrl(email: string, baseUrl: string): string {
  const token = generateUnsubscribeToken(email);
  return `${baseUrl}/api/unsubscribe/${token}`;
}
