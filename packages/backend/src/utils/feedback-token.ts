/**
 * Feedback Token Utility
 *
 * Generates and verifies HMAC-signed tokens that prove a feedback link
 * came from an email we sent. Without this proof, anyone who guesses a
 * tracking code (SPL-{4d}-{4d}-{seq}, low entropy by design) could
 * submit feedback for an appointment, prematurely transitioning it to
 * `completed` and exposing the user/therapist names via the pre-fill
 * endpoint.
 *
 * Crypto primitives live in `hmac-token.ts` — this module only sets
 * the context, version, and payload semantics for feedback tokens.
 */

import { signTimestampedToken, verifyTimestampedToken } from './hmac-token';

const TOKEN_VERSION = 'v1';
const HMAC_KEY_CONTEXT = 'feedback-token-v1';
const DEFAULT_VALIDITY_DAYS = 90; // Generous: feedback windows are long

export interface FeedbackTokenPayload {
  appointmentId: string;
  expired: boolean;
}

/**
 * Generate a signed feedback token bound to an appointment ID.
 * `validityDays` is unused at signing time — expiry is enforced at
 * verification time via `validateFeedbackToken`.
 */
export function generateFeedbackToken(
  appointmentId: string,
  _validityDays: number = DEFAULT_VALIDITY_DAYS,
): string {
  return signTimestampedToken({
    context: HMAC_KEY_CONTEXT,
    version: TOKEN_VERSION,
    payload: appointmentId,
  });
}

/**
 * Verify a feedback token and extract the appointment ID. Returns null
 * for malformed input, version mismatch, or signatures that don't
 * verify against any current/rotation key. The `expired` flag is set
 * for signature-valid tokens older than `validityDays`; callers
 * decide how to handle them.
 */
export function validateFeedbackToken(
  token: string,
  validityDays: number = DEFAULT_VALIDITY_DAYS,
): FeedbackTokenPayload | null {
  const verified = verifyTimestampedToken(token, {
    context: HMAC_KEY_CONTEXT,
    expectedVersion: TOKEN_VERSION,
    validityDays,
  });
  if (!verified) return null;
  return { appointmentId: verified.payload, expired: verified.expired };
}
