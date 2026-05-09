/**
 * Voucher Token Utility
 *
 * Generates and verifies HMAC-signed voucher tokens for booking
 * authorization. Voucher codes are included in weekly promotional
 * emails and auto-applied via URL. They are tied to the recipient's
 * email address and expire after a configurable period.
 *
 * Display codes use a what3words-style format: three memorable words
 * joined by hyphens (e.g. "gentle-river-bloom"). The display code is
 * derived from the first three bytes of the HMAC signature, so it's
 * deterministic per token and not separately authenticated.
 *
 * Crypto primitives live in `hmac-token.ts` — see there for the
 * timestamped 4-part token format and rotation handling.
 */

import { signTimestampedToken, verifyTimestampedToken } from './hmac-token';
import { VOUCHER_WORD_LIST } from '@therapist-scheduler/shared';

const TOKEN_VERSION = 'v1';
const HMAC_KEY_CONTEXT = 'voucher-token-v1';
const DEFAULT_VALIDITY_DAYS = 14;

export interface VoucherTokenResult {
  token: string;
  displayCode: string;
  expiresAt: Date;
}

export interface VoucherValidationResult {
  valid: boolean;
  email: string | null;
  expired: boolean;
}

/**
 * Generate a what3words-style display code from a token's signature.
 * Three bytes of the signature index into VOUCHER_WORD_LIST; the
 * result is deterministic for the token and not separately signed
 * (it's a UI affordance, not a credential).
 *
 * Returns null for malformed tokens (anything that doesn't split
 * into the expected 4 parts).
 */
export function getDisplayCodeFromToken(token: string): string | null {
  const parts = token.split(':');
  if (parts.length !== 4) return null;

  const sigBytes = Buffer.from(parts[3], 'base64url');
  return [
    VOUCHER_WORD_LIST[sigBytes[0] % VOUCHER_WORD_LIST.length],
    VOUCHER_WORD_LIST[sigBytes[1] % VOUCHER_WORD_LIST.length],
    VOUCHER_WORD_LIST[sigBytes[2] % VOUCHER_WORD_LIST.length],
  ].join('-');
}

/**
 * Generate a signed voucher token for an email address.
 *
 * The validity window is enforced at validation time, not signed in,
 * so admins can change the expiry policy without invalidating live
 * tokens.
 */
export function generateVoucherToken(
  email: string,
  validityDays: number = DEFAULT_VALIDITY_DAYS,
): VoucherTokenResult {
  const token = signTimestampedToken({
    context: HMAC_KEY_CONTEXT,
    version: TOKEN_VERSION,
    payload: email.toLowerCase(),
  });
  return {
    token,
    displayCode: getDisplayCodeFromToken(token)!,
    expiresAt: new Date(Date.now() + validityDays * 24 * 60 * 60 * 1000),
  };
}

/**
 * Validate a voucher token and extract the email address.
 *
 * Returns `{valid, email, expired}` where:
 *   - signature invalid / malformed: `{valid: false, email: null, expired: false}`
 *   - signature valid but expired: `{valid: false, email, expired: true}`
 *     (caller surfaces "your voucher expired" with the email shown)
 *   - signature valid and fresh: `{valid: true, email, expired: false}`
 */
export function validateVoucherToken(
  token: string,
  validityDays: number = DEFAULT_VALIDITY_DAYS,
): VoucherValidationResult {
  const verified = verifyTimestampedToken(token, {
    context: HMAC_KEY_CONTEXT,
    expectedVersion: TOKEN_VERSION,
    validityDays,
  });
  if (!verified) {
    return { valid: false, email: null, expired: false };
  }
  return {
    valid: !verified.expired,
    email: verified.payload,
    expired: verified.expired,
  };
}

/**
 * Build a full booking URL with the voucher token as a query parameter.
 * Appends with `&` if the base already has a query string.
 */
export function generateVoucherUrl(
  email: string,
  baseWebAppUrl: string,
  validityDays: number = DEFAULT_VALIDITY_DAYS,
): {
  url: string;
  token: string;
  displayCode: string;
  expiresAt: Date;
} {
  const result = generateVoucherToken(email, validityDays);
  const separator = baseWebAppUrl.includes('?') ? '&' : '?';
  return {
    ...result,
    url: `${baseWebAppUrl}${separator}voucher=${encodeURIComponent(result.token)}`,
  };
}
