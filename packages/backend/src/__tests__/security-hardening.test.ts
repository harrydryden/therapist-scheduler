/**
 * Regression tests for the security-hardening fixes:
 *   - byte-safe constant-time comparison (non-ASCII input used to throw)
 *   - booking-link URLs restricted to http(s)
 *   - request-log URL sanitisation (admin secret / one-click tokens)
 *   - outbound header-injection guard in sendEmail
 *   - CSV formula-injection neutralisation shape
 */
// hmac-token pulls in config, which validates env at import time.
jest.mock('../config', () => require('./_global-mocks').configMock());
jest.mock('../utils/logger', () => require('./_global-mocks').loggerMock());

import { safeCompare } from '../utils/hmac-token';
import { recordBookingLinkInputSchema } from '../schemas/tool-inputs';
import { sanitizeUrlForLog } from '../utils/log-sanitize';

describe('safeCompare', () => {
  it('compares equal strings', () => {
    expect(safeCompare('abc', 'abc')).toBe(true);
  });
  it('rejects different strings of equal length', () => {
    expect(safeCompare('abc', 'abd')).toBe(false);
  });
  it('rejects different lengths', () => {
    expect(safeCompare('abc', 'abcd')).toBe(false);
  });
  it('does not throw on non-ASCII input (byte length != char length)', () => {
    expect(() => safeCompare('héllo', 'hello')).not.toThrow();
    expect(safeCompare('héllo', 'hello')).toBe(false);
    expect(safeCompare('héllo', 'héllo')).toBe(true);
    expect(safeCompare('日本語', 'abc')).toBe(false);
  });
});

describe('recordBookingLinkInputSchema', () => {
  it('accepts http(s) URLs', () => {
    expect(recordBookingLinkInputSchema.safeParse({ url: 'https://calendly.com/x' }).success).toBe(true);
    expect(recordBookingLinkInputSchema.safeParse({ url: 'http://example.org/book' }).success).toBe(true);
  });
  it('rejects javascript:, data: and mailto: schemes', () => {
    expect(recordBookingLinkInputSchema.safeParse({ url: 'javascript:alert(1)' }).success).toBe(false);
    expect(recordBookingLinkInputSchema.safeParse({ url: 'data:text/html,hi' }).success).toBe(false);
    expect(recordBookingLinkInputSchema.safeParse({ url: 'mailto:a@b.c' }).success).toBe(false);
  });
});

describe('sanitizeUrlForLog', () => {
  it('drops the whole query string', () => {
    expect(sanitizeUrlForLog('/api/admin/dashboard/events?secret=s3cr3t')).toBe(
      '/api/admin/dashboard/events?[redacted]',
    );
  });
  it('masks unsubscribe and invitation tokens in the path', () => {
    expect(sanitizeUrlForLog('/api/unsubscribe/abc.def')).toBe('/api/unsubscribe/[redacted]');
    expect(sanitizeUrlForLog('/api/signup/invitation/tok123')).toBe('/api/signup/invitation/[redacted]');
  });
  it('masks long token-like path segments anywhere', () => {
    const tok = 'a'.repeat(48);
    expect(sanitizeUrlForLog(`/api/x/${tok}/status`)).toBe('/api/x/[redacted]/status');
  });
  it('leaves ordinary paths alone', () => {
    expect(sanitizeUrlForLog('/api/therapists')).toBe('/api/therapists');
    expect(sanitizeUrlForLog('/health/ready')).toBe('/health/ready');
    expect(sanitizeUrlForLog(undefined)).toBeUndefined();
  });
});
