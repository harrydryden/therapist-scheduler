/**
 * Tests for the feedback-token HMAC util used to gate
 * `transitionToCompleted` triggered by the public feedback form.
 *
 * Failure modes locked down here:
 *   - tampered token → invalid (so a guessed SPL code alone can't drive
 *     the appointment to a terminal state)
 *   - expired token → expired flag set (caller decides whether to honor)
 *   - wrong-context HMAC (e.g. a voucher token re-used as a feedback
 *     token) → invalid (different HMAC_KEY_CONTEXT)
 *   - well-formed token round-trips back to the appointment ID
 */

jest.mock('../config', () => ({
  config: { jwtSecret: 'test-secret-for-feedback-tokens' },
}));

import { generateFeedbackToken, validateFeedbackToken } from '../utils/feedback-token';
import { generateVoucherToken } from '../utils/voucher-token';

describe('feedback-token', () => {
  it('round-trips a valid token to the originating appointment id', () => {
    const apptId = 'apt-' + Math.random().toString(36).slice(2);
    const token = generateFeedbackToken(apptId);
    const result = validateFeedbackToken(token);
    expect(result).not.toBeNull();
    expect(result?.appointmentId).toBe(apptId);
    expect(result?.expired).toBe(false);
  });

  it('returns null for a tampered signature', () => {
    const token = generateFeedbackToken('apt-tampered');
    const parts = token.split(':');
    parts[3] = 'a'.repeat(parts[3].length); // overwrite signature
    expect(validateFeedbackToken(parts.join(':'))).toBeNull();
  });

  it('returns null for a tampered appointment id (signature no longer covers it)', () => {
    const token = generateFeedbackToken('apt-original');
    const parts = token.split(':');
    parts[2] = Buffer.from('apt-evil').toString('base64url');
    expect(validateFeedbackToken(parts.join(':'))).toBeNull();
  });

  it('returns null for malformed input', () => {
    expect(validateFeedbackToken('')).toBeNull();
    expect(validateFeedbackToken('not-a-token')).toBeNull();
    expect(validateFeedbackToken('v1:abc')).toBeNull();
  });

  it('flags an expired token rather than treating it as valid', () => {
    // Hand-craft a v1 token with a very old timestamp so the validator
    // sees it as expired but the signature still verifies.
    const apptId = 'apt-expired';
    const oldTimestamp = (Date.now() - 365 * 24 * 60 * 60 * 1000).toString(36);
    const idB64 = Buffer.from(apptId).toString('base64url');
    const payload = `v1:${oldTimestamp}:${idB64}`;
    const crypto = require('crypto');
    const hmacKey = crypto
      .createHmac('sha256', 'test-secret-for-feedback-tokens')
      .update('feedback-token-v1')
      .digest('hex');
    const signature = crypto
      .createHmac('sha256', hmacKey)
      .update(payload)
      .digest('base64url');
    const token = `${payload}:${signature}`;

    // 1 day validity → 365 day-old token must be flagged expired
    const result = validateFeedbackToken(token, 1);
    expect(result).not.toBeNull();
    expect(result?.expired).toBe(true);
    expect(result?.appointmentId).toBe(apptId);
  });

  it('rejects a token signed with the voucher HMAC context (cross-token reuse)', () => {
    // generateVoucherToken signs an *email*, not an appointment id, but
    // even if the user crafts one with the same payload shape the HMAC
    // contexts are different — feedback tokens MUST NOT be honored when
    // signed by the voucher key.
    const voucherToken = generateVoucherToken('victim@example.com').token;
    expect(validateFeedbackToken(voucherToken)).toBeNull();
  });
});
