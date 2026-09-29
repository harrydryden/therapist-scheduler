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
  /** When this voucher expires (its own validity, else the default). Null when unparseable. */
  expiresAt: Date | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Payload is `email` (legacy) or `email\n<validityDays>`. The validity is
 * signed in so a voucher issued with a custom expiry (admin "issue for 30
 * days") is honoured at booking time instead of the global setting, and
 * can't be extended by editing the token. A newline can't occur in a
 * validated email address.
 */
function parseVoucherPayload(payload: string): { email: string; validityDays: number | null } {
  const newline = payload.indexOf('\n');
  if (newline === -1) return { email: payload, validityDays: null };
  const days = Number(payload.slice(newline + 1));
  return {
    email: payload.slice(0, newline),
    validityDays: Number.isFinite(days) && days > 0 ? days : null,
  };
}

/**
 * The expiry of a voucher token: issue time plus the validity signed into
 * it, or `defaultValidityDays` for legacy tokens that carry none. Does NOT
 * check the signature — use validateVoucherToken for that. Null when the
 * token is malformed.
 */
export function getVoucherExpiresAt(token: string, defaultValidityDays: number = DEFAULT_VALIDITY_DAYS): Date | null {
  const parts = token.split(':');
  if (parts.length !== 4) return null;
  const issuedAt = parseInt(parts[1], 36);
  if (isNaN(issuedAt)) return null;
  let payload: string;
  try {
    payload = Buffer.from(parts[2], 'base64url').toString('utf-8');
  } catch {
    return null;
  }
  const { validityDays } = parseVoucherPayload(payload);
  return new Date(issuedAt + (validityDays ?? defaultValidityDays) * DAY_MS);
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
 * The validity window is signed into the token, so the expiry the
 * recipient was told (e.g. an admin-issued 30-day voucher) is the one
 * enforced at booking time. Tokens issued before this carried no
 * validity and are still checked against the global setting.
 */
export function generateVoucherToken(
  email: string,
  validityDays: number = DEFAULT_VALIDITY_DAYS,
): VoucherTokenResult {
  const token = signTimestampedToken({
    context: HMAC_KEY_CONTEXT,
    version: TOKEN_VERSION,
    payload: `${email.toLowerCase()}\n${validityDays}`,
  });
  return {
    token,
    displayCode: getDisplayCodeFromToken(token)!,
    expiresAt: getVoucherExpiresAt(token, validityDays)!,
  };
}

/**
 * Validate a voucher token and extract the email address.
 *
 * Expiry is the token's OWN signed validity; `defaultValidityDays` (the
 * global `voucher.expiryDays` setting) only applies to legacy tokens that
 * carry none.
 *
 * Returns `{valid, email, expired, expiresAt}` where:
 *   - signature invalid / malformed: `{valid: false, email: null, expired: false}`
 *   - signature valid but expired: `{valid: false, email, expired: true}`
 *     (caller surfaces "your voucher expired" with the email shown)
 *   - signature valid and fresh: `{valid: true, email, expired: false}`
 */
export function validateVoucherToken(
  token: string,
  defaultValidityDays: number = DEFAULT_VALIDITY_DAYS,
): VoucherValidationResult {
  const verified = verifyTimestampedToken(token, {
    context: HMAC_KEY_CONTEXT,
    expectedVersion: TOKEN_VERSION,
    validityDays: defaultValidityDays,
  });
  if (!verified) {
    return { valid: false, email: null, expired: false, expiresAt: null };
  }
  const { email } = parseVoucherPayload(verified.payload);
  const expiresAt = getVoucherExpiresAt(token, defaultValidityDays);
  const expired = !expiresAt || Date.now() > expiresAt.getTime();
  return {
    valid: !expired,
    email,
    expired,
    expiresAt,
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
