/**
 * Signup invitation tokens.
 *
 * Format: 32 random bytes encoded as 64 hex characters. The raw token is
 * only ever in the emailed URL; the database stores only its SHA-256 hash.
 * If the DB leaks, leaked rows can't be redeemed (the attacker doesn't have
 * the pre-image), and a leaked URL can be revoked by clearing or rotating
 * the row server-side.
 *
 * Why opaque-random rather than HMAC-self-contained (like voucher tokens):
 * we need server-side revocation, which forces a DB lookup anyway, so
 * there's no caching benefit to encoding the email/issuer in the token.
 * Random + hash is simpler and leaks less metadata in the URL.
 */

import { randomBytes, createHash } from 'crypto';

const TOKEN_BYTES = 32; // 64 hex chars
const HEX_REGEX = /^[a-f0-9]{64}$/;

export interface NewInvitationToken {
  /** Raw token to embed in the signup URL. Never persisted. */
  raw: string;
  /** SHA-256 hex digest stored in `signup_invitations.token_hash`. */
  hash: string;
}

/**
 * Generate a fresh invitation token. Returns both the raw token (for the
 * URL) and the hash (for DB persistence).
 */
export function generateInvitationToken(): NewInvitationToken {
  const raw = randomBytes(TOKEN_BYTES).toString('hex');
  return { raw, hash: hashInvitationToken(raw) };
}

/**
 * Compute the storage hash for a raw token. Used both at generation time
 * and at lookup time when verifying an inbound URL.
 */
export function hashInvitationToken(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

/**
 * Cheap shape check before hashing — rejects obviously malformed tokens
 * without doing the work of a DB lookup. Returns false for empty strings,
 * tokens of the wrong length, or tokens with non-hex characters.
 */
export function isWellFormedInvitationToken(raw: string | null | undefined): boolean {
  if (!raw || typeof raw !== 'string') return false;
  return HEX_REGEX.test(raw);
}

/**
 * Build the public signup URL with the invitation token attached.
 * `baseUrl` should be the public-facing origin (no trailing slash needed).
 */
export function buildInvitationUrl(baseUrl: string, raw: string): string {
  const trimmed = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  return `${trimmed}/signup?invite=${encodeURIComponent(raw)}`;
}
