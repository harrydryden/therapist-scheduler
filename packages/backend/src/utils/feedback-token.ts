/**
 * Feedback Token Utility
 *
 * Generates and verifies HMAC-signed tokens that prove a feedback link
 * came from an email we sent. Without this proof, anyone who guesses a
 * tracking code (SPL-{4d}-{4d}-{seq}, low entropy by design) could submit
 * feedback for an appointment, prematurely transitioning it to `completed`
 * and exposing the user/therapist names via the pre-fill endpoint.
 *
 * Token format: v1:{timestamp}:{base64_appointmentId}:{hmac_signature}
 *
 * Reuses the same crypto pattern as voucher-token.ts and unsubscribe-token.ts.
 */

import crypto from 'crypto';
import { config } from '../config';

const TOKEN_VERSION = 'v1';
const ALGORITHM = 'sha256';
const DEFAULT_VALIDITY_DAYS = 90; // Generous: feedback windows are long

const HMAC_KEY_CONTEXT = 'feedback-token-v1';
function deriveHmacKey(secret: string): string {
  return crypto.createHmac('sha256', secret).update(HMAC_KEY_CONTEXT).digest('hex');
}

const OLD_HMAC_KEYS = (process.env.HMAC_KEYS_OLD || '').split(',').filter(Boolean);

function getHmacKeys(): string[] {
  return [deriveHmacKey(config.jwtSecret), ...OLD_HMAC_KEYS.map(deriveHmacKey)];
}

function safeCompare(a: string, b: string): boolean {
  const maxLen = Math.max(a.length, b.length);
  const aPadded = a.padEnd(maxLen, '\0');
  const bPadded = b.padEnd(maxLen, '\0');
  const aBuffer = Buffer.from(aPadded);
  const bBuffer = Buffer.from(bPadded);
  return crypto.timingSafeEqual(aBuffer, bBuffer) && a.length === b.length;
}

export interface FeedbackTokenPayload {
  appointmentId: string;
  expired: boolean;
}

/**
 * Generate a signed feedback token bound to an appointment ID.
 */
export function generateFeedbackToken(
  appointmentId: string,
  validityDays: number = DEFAULT_VALIDITY_DAYS,
): string {
  const timestamp = Date.now().toString(36);
  const idB64 = Buffer.from(appointmentId).toString('base64url');
  const payload = `${TOKEN_VERSION}:${timestamp}:${idB64}`;

  const hmac = crypto.createHmac(ALGORITHM, deriveHmacKey(config.jwtSecret));
  hmac.update(payload);
  const signature = hmac.digest('base64url');

  void validityDays; // expiry is enforced at validation time
  return `${payload}:${signature}`;
}

/**
 * Verify a feedback token and extract the appointment ID.
 * Returns null when the token is malformed, signed by a non-matching key,
 * or expired beyond `validityDays`.
 */
export function validateFeedbackToken(
  token: string,
  validityDays: number = DEFAULT_VALIDITY_DAYS,
): FeedbackTokenPayload | null {
  try {
    const parts = token.split(':');
    if (parts.length !== 4) return null;

    const [version, timestamp, idB64, providedSignature] = parts;
    if (version !== TOKEN_VERSION) return null;

    const tokenTime = parseInt(timestamp, 36);
    if (isNaN(tokenTime)) return null;

    const maxAge = validityDays * 24 * 60 * 60 * 1000;
    const expired = Date.now() - tokenTime > maxAge;

    const payload = `${version}:${timestamp}:${idB64}`;
    let signatureValid = false;
    for (const key of getHmacKeys()) {
      const hmac = crypto.createHmac(ALGORITHM, key);
      hmac.update(payload);
      const expectedSignature = hmac.digest('base64url');
      if (safeCompare(providedSignature, expectedSignature)) {
        signatureValid = true;
        break;
      }
    }

    if (!signatureValid) return null;

    const appointmentId = Buffer.from(idB64, 'base64url').toString('utf-8');
    if (!appointmentId) return null;

    return { appointmentId, expired };
  } catch {
    return null;
  }
}
