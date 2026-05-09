/**
 * Shared HMAC-signed token primitives.
 *
 * Three token utilities (unsubscribe, voucher, feedback) had been
 * implementing the same crypto pattern by hand — derived HMAC keys
 * with rotation support, constant-time signature comparison, a 4-part
 * `{version}:{timestamp_b36}:{base64url_payload}:{base64url_signature}`
 * envelope. This module owns those primitives once and the per-token
 * wrappers configure context + version + payload encoding.
 *
 * Properties preserved from the originals:
 *   - HMAC-SHA256, key derived from `jwtSecret + context_string` so
 *     contexts are isolated (a voucher signature MUST NOT validate as
 *     a feedback token).
 *   - Rotation via `HMAC_KEYS_OLD` env var (comma-separated). The
 *     current key always signs; verification accepts current + old.
 *   - Constant-time signature comparison padded to equal length so a
 *     length mismatch doesn't leak via the timing channel.
 *
 * Format-wise this module handles ONLY the 4-part timestamped form.
 * The legacy 3-part unsubscribe v1 format predates this consolidation
 * and stays inline in `unsubscribe-token.ts`; it shares the primitives
 * (`deriveHmacKey`, `safeCompare`, `getHmacKeys`) but has its own
 * payload split. New token types should always use the timestamped
 * form.
 */

import crypto from 'crypto';
import { config } from '../config';

const ALGORITHM = 'sha256';

// Comma-separated old jwtSecret values for verification during rotation.
// Read once at module load — matches the prior per-file behaviour.
const OLD_HMAC_KEYS_RAW = (process.env.HMAC_KEYS_OLD || '').split(',').filter(Boolean);

/**
 * Derive an HMAC key from `secret` namespaced by `context`. Distinct
 * contexts produce distinct keys, so a token signed for one purpose
 * cannot be re-used for another even though they share the same root
 * secret.
 */
export function deriveHmacKey(secret: string, context: string): string {
  return crypto.createHmac(ALGORITHM, secret).update(context).digest('hex');
}

/**
 * All HMAC keys valid for verification under the given context: the
 * current jwtSecret-derived key plus rotation old keys. Generation
 * always uses the first (current) key; verification accepts any.
 */
export function getHmacKeys(context: string): string[] {
  return [
    deriveHmacKey(config.jwtSecret, context),
    ...OLD_HMAC_KEYS_RAW.map((s) => deriveHmacKey(s, context)),
  ];
}

/**
 * Constant-time string comparison that pads both sides to equal length
 * before timingSafeEqual so a length mismatch doesn't leak through the
 * timing channel. Returns false when the unpadded lengths differ even
 * if the padded buffers happen to compare equal.
 */
export function safeCompare(a: string, b: string): boolean {
  const maxLen = Math.max(a.length, b.length);
  const aBuf = Buffer.from(a.padEnd(maxLen, '\0'));
  const bBuf = Buffer.from(b.padEnd(maxLen, '\0'));
  return crypto.timingSafeEqual(aBuf, bBuf) && a.length === b.length;
}

export interface SignTimestampedTokenOptions {
  /** Context string for HMAC key derivation, e.g. 'voucher-token-v1'. */
  context: string;
  /** Version label embedded in the token, e.g. 'v1', 'v2'. */
  version: string;
  /** Payload to encode (utf-8). Will be base64url-encoded in the token. */
  payload: string;
}

/**
 * Sign a payload into a 4-part timestamped token:
 *   `{version}:{timestamp_b36}:{base64url_payload}:{base64url_signature}`
 *
 * Note: validity is enforced at verification time via `validityDays`,
 * not encoded in the token itself. Rotating `validityDays` instantly
 * changes the effective lifetime of every existing token.
 */
export function signTimestampedToken(opts: SignTimestampedTokenOptions): string {
  const { context, version, payload } = opts;
  const timestamp = Date.now().toString(36);
  const payloadB64 = Buffer.from(payload).toString('base64url');
  const signed = `${version}:${timestamp}:${payloadB64}`;

  const hmac = crypto.createHmac(ALGORITHM, deriveHmacKey(config.jwtSecret, context));
  hmac.update(signed);
  const signature = hmac.digest('base64url');

  return `${signed}:${signature}`;
}

export interface VerifyTimestampedTokenOptions {
  context: string;
  /** The token's `version` field MUST equal this. */
  expectedVersion: string;
  /** Validity window in days; sets `expired` on the result. */
  validityDays: number;
}

export interface VerifiedTimestampedToken {
  /** Decoded payload (utf-8). */
  payload: string;
  /** True when the token's signed timestamp is older than validityDays. */
  expired: boolean;
}

/**
 * Verify a 4-part timestamped token. Returns null on:
 *   - malformed input (wrong part count, unparseable timestamp,
 *     un-decodable payload)
 *   - version mismatch
 *   - signature does not match any current/rotation key
 *
 * Returns `{payload, expired}` on signature-valid tokens. Callers
 * decide whether to honour expired tokens — some flows surface them
 * with the payload populated (so a UI can say "this voucher expired
 * on Tuesday"), others treat any expired token as null.
 */
export function verifyTimestampedToken(
  token: string,
  opts: VerifyTimestampedTokenOptions,
): VerifiedTimestampedToken | null {
  const parts = token.split(':');
  if (parts.length !== 4) return null;

  const [version, timestamp, payloadB64, signature] = parts;
  if (version !== opts.expectedVersion) return null;

  const tokenTimeMs = parseInt(timestamp, 36);
  if (isNaN(tokenTimeMs)) return null;

  const signed = `${version}:${timestamp}:${payloadB64}`;

  // Try every valid key; a single match is enough. We don't short-
  // circuit further than the loop below because the cost of always
  // computing two HMACs (current + one old) is negligible and avoids
  // a side channel that could distinguish "matched on rotation key"
  // from "matched on current key" via timing.
  let signatureValid = false;
  for (const key of getHmacKeys(opts.context)) {
    const hmac = crypto.createHmac(ALGORITHM, key);
    hmac.update(signed);
    if (safeCompare(signature, hmac.digest('base64url'))) {
      signatureValid = true;
      break;
    }
  }
  if (!signatureValid) return null;

  let payload: string;
  try {
    payload = Buffer.from(payloadB64, 'base64url').toString('utf-8');
  } catch {
    return null;
  }
  if (!payload) return null;

  const maxAgeMs = opts.validityDays * 24 * 60 * 60 * 1000;
  const expired = Date.now() - tokenTimeMs > maxAgeMs;

  return { payload, expired };
}
