/**
 * Voucher Token Utility
 *
 * Generates and verifies HMAC-signed voucher tokens for booking authorization.
 * Token format: v1:{timestamp}:{base64_email}:{hmac_signature}
 *
 * Voucher codes are included in weekly promotional emails and auto-applied via URL.
 * They are tied to the recipient's email address and expire after a configurable period.
 *
 * Display codes use a what3words-style format: three memorable words joined by hyphens.
 * Example: "gentle-river-bloom"
 *
 * Reuses the same cryptographic patterns as unsubscribe-token.ts:
 * - HMAC-SHA256 signing with derived key
 * - Base64url encoding for email
 * - Constant-time comparison to prevent timing attacks
 * - Key rotation support via HMAC_KEYS_OLD
 */

import crypto from 'crypto';
import { config } from '../config';
import { VOUCHER_WORD_LIST } from '@therapist-scheduler/shared';

const TOKEN_VERSION = 'v1';
const ALGORITHM = 'sha256';
const DEFAULT_VALIDITY_DAYS = 14;

// Derive a dedicated HMAC key from jwtSecret so voucher tokens don't share
// the same raw key material as JWT or unsubscribe tokens
const HMAC_KEY_CONTEXT = 'voucher-token-v1';
function deriveHmacKey(secret: string): string {
  return crypto.createHmac('sha256', secret).update(HMAC_KEY_CONTEXT).digest('hex');
}

// Support key rotation - current key plus any old keys for verification
const OLD_HMAC_KEYS = (process.env.HMAC_KEYS_OLD || '').split(',').filter(Boolean);

function getHmacKeys(): string[] {
  return [deriveHmacKey(config.jwtSecret), ...OLD_HMAC_KEYS.map(deriveHmacKey)];
}

/**
 * Constant-time string comparison that doesn't leak length information
 */
function safeCompare(a: string, b: string): boolean {
  const maxLen = Math.max(a.length, b.length);
  const aPadded = a.padEnd(maxLen, '\0');
  const bPadded = b.padEnd(maxLen, '\0');

  const aBuffer = Buffer.from(aPadded);
  const bBuffer = Buffer.from(bPadded);

  return crypto.timingSafeEqual(aBuffer, bBuffer) && a.length === b.length;
}

// ============================================
// What3Words-style Display Code Generation
// ============================================

/**
 * Generate a what3words-style display code from an HMAC signature.
 * Takes 3 bytes from the signature to select 3 words from a 256-word list.
 * Example: "gentle-river-bloom"
 */
export function getDisplayCodeFromToken(token: string): string | null {
  const parts = token.split(':');
  if (parts.length !== 4) return null;

  const signature = parts[3];
  const sigBytes = Buffer.from(signature, 'base64url');

  // Use first 3 bytes to index into word list (each byte 0-255 maps to a word)
  const word1 = VOUCHER_WORD_LIST[sigBytes[0] % VOUCHER_WORD_LIST.length];
  const word2 = VOUCHER_WORD_LIST[sigBytes[1] % VOUCHER_WORD_LIST.length];
  const word3 = VOUCHER_WORD_LIST[sigBytes[2] % VOUCHER_WORD_LIST.length];

  return `${word1}-${word2}-${word3}`;
}

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
 * Generate a signed voucher token for an email address
 */
export function generateVoucherToken(email: string, validityDays: number = DEFAULT_VALIDITY_DAYS): VoucherTokenResult {
  const timestamp = Date.now().toString(36); // Compact timestamp encoding
  const emailB64 = Buffer.from(email.toLowerCase()).toString('base64url');
  const payload = `${TOKEN_VERSION}:${timestamp}:${emailB64}`;

  const hmac = crypto.createHmac(ALGORITHM, deriveHmacKey(config.jwtSecret));
  hmac.update(payload);
  const signature = hmac.digest('base64url');

  const token = `${payload}:${signature}`;
  const expiresAt = new Date(Date.now() + validityDays * 24 * 60 * 60 * 1000);

  return {
    token,
    displayCode: getDisplayCodeFromToken(token)!,
    expiresAt,
  };
}

/**
 * Validate a voucher token and extract the email address.
 * Returns validation result with email if valid, or expired/invalid status.
 */
export function validateVoucherToken(token: string, validityDays: number = DEFAULT_VALIDITY_DAYS): VoucherValidationResult {
  try {
    const parts = token.split(':');
    if (parts.length !== 4) {
      return { valid: false, email: null, expired: false };
    }

    const [version, timestamp, emailB64, providedSignature] = parts;

    if (version !== TOKEN_VERSION) {
      return { valid: false, email: null, expired: false };
    }

    // Check token expiration
    const tokenTime = parseInt(timestamp, 36);
    const now = Date.now();
    const maxAge = validityDays * 24 * 60 * 60 * 1000;

    if (isNaN(tokenTime)) {
      return { valid: false, email: null, expired: false };
    }

    const isExpired = now - tokenTime > maxAge;

    // Verify signature with current key first, then old keys for rotation support
    const payload = `${version}:${timestamp}:${emailB64}`;
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

    if (!signatureValid) {
      return { valid: false, email: null, expired: false };
    }

    const email = Buffer.from(emailB64, 'base64url').toString('utf-8');

    if (isExpired) {
      return { valid: false, email, expired: true };
    }

    return { valid: true, email, expired: false };
  } catch {
    return { valid: false, email: null, expired: false };
  }
}

/**
 * Generate a full booking URL with voucher token as query parameter
 */
export function generateVoucherUrl(email: string, baseWebAppUrl: string, validityDays: number = DEFAULT_VALIDITY_DAYS): {
  url: string;
  token: string;
  displayCode: string;
  expiresAt: Date;
} {
  const { token, displayCode, expiresAt } = generateVoucherToken(email, validityDays);
  const separator = baseWebAppUrl.includes('?') ? '&' : '?';
  const url = `${baseWebAppUrl}${separator}voucher=${encodeURIComponent(token)}`;
  return { url, token, displayCode, expiresAt };
}
