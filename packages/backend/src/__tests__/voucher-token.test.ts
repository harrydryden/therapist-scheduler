/**
 * Tests for voucher token generation, validation, and display code derivation
 *
 * Covers: token lifecycle, expiry, tampering, key rotation, display codes
 */

jest.mock('../config', () => ({
  config: { jwtSecret: 'test-secret-key-for-unit-tests' },
}));

import {
  generateVoucherToken,
  validateVoucherToken,
  getDisplayCodeFromToken,
  generateVoucherUrl,
} from '../utils/voucher-token';

describe('voucher tokens', () => {
  const testEmail = 'user@example.com';

  // ---- Generation ----

  it('generates a valid token that passes validation', () => {
    const { token } = generateVoucherToken(testEmail);
    const result = validateVoucherToken(token);
    expect(result.valid).toBe(true);
    expect(result.email).toBe(testEmail);
    expect(result.expired).toBe(false);
  });

  it('normalizes email to lowercase', () => {
    const { token } = generateVoucherToken('User@Example.COM');
    const result = validateVoucherToken(token);
    expect(result.email).toBe('user@example.com');
  });

  it('generates v1-prefixed tokens', () => {
    const { token } = generateVoucherToken(testEmail);
    expect(token.startsWith('v1:')).toBe(true);
  });

  it('generates 4-part tokens', () => {
    const { token } = generateVoucherToken(testEmail);
    expect(token.split(':')).toHaveLength(4);
  });

  it('sets expiresAt based on validity days', () => {
    const before = Date.now();
    const { expiresAt } = generateVoucherToken(testEmail, 7);
    const after = Date.now();

    const expectedMin = before + 7 * 24 * 60 * 60 * 1000;
    const expectedMax = after + 7 * 24 * 60 * 60 * 1000;
    expect(expiresAt.getTime()).toBeGreaterThanOrEqual(expectedMin);
    expect(expiresAt.getTime()).toBeLessThanOrEqual(expectedMax);
  });

  it('generates different tokens for different emails', () => {
    const t1 = generateVoucherToken('a@test.com');
    const t2 = generateVoucherToken('b@test.com');
    expect(t1.token).not.toBe(t2.token);
  });

  // ---- Validation ----

  it('rejects tampered signature', () => {
    const { token } = generateVoucherToken(testEmail);
    const tampered = token.slice(0, -5) + 'XXXXX';
    const result = validateVoucherToken(tampered);
    expect(result.valid).toBe(false);
    expect(result.email).toBeNull();
  });

  it('rejects tampered email payload', () => {
    const { token } = generateVoucherToken(testEmail);
    const parts = token.split(':');
    // Replace email base64 with different email
    parts[2] = Buffer.from('evil@attacker.com').toString('base64url');
    const result = validateVoucherToken(parts.join(':'));
    expect(result.valid).toBe(false);
  });

  it('rejects wrong version', () => {
    const { token } = generateVoucherToken(testEmail);
    const wrongVersion = 'v99' + token.slice(2);
    const result = validateVoucherToken(wrongVersion);
    expect(result.valid).toBe(false);
  });

  it('rejects malformed tokens', () => {
    expect(validateVoucherToken('').valid).toBe(false);
    expect(validateVoucherToken('not-a-token').valid).toBe(false);
    expect(validateVoucherToken('v1::').valid).toBe(false);
    expect(validateVoucherToken('a:b:c:d:e').valid).toBe(false);
  });

  it('rejects invalid timestamp', () => {
    const result = validateVoucherToken('v1:ZZZZ:dXNlckBleGFtcGxlLmNvbQ:fakesig');
    expect(result.valid).toBe(false);
  });

  // ---- Expiry ----

  it('reports expired for tokens past their validity window', () => {
    // Generate token "15 days ago" by shifting Date.now during generation
    const fifteenDaysMs = 15 * 24 * 60 * 60 * 1000;
    const realNow = Date.now();
    const spy = jest.spyOn(Date, 'now').mockReturnValue(realNow - fifteenDaysMs);
    const { token } = generateVoucherToken(testEmail, 14);
    spy.mockRestore();

    // Validate now (15 days later) with 14-day validity → expired
    const result = validateVoucherToken(token, 14);
    expect(result.valid).toBe(false);
    expect(result.expired).toBe(true);
    expect(result.email).toBe(testEmail);
  });

  it('reports valid for fresh token within validity window', () => {
    const { token } = generateVoucherToken(testEmail, 14);
    const result = validateVoucherToken(token, 14);
    expect(result.valid).toBe(true);
    expect(result.expired).toBe(false);
  });

  // ---- Display Codes ----

  it('generates a three-word display code', () => {
    const { displayCode } = generateVoucherToken(testEmail);
    const words = displayCode.split('-');
    expect(words).toHaveLength(3);
    words.forEach((word) => {
      expect(word.length).toBeGreaterThan(0);
      expect(word).toMatch(/^[a-z]+$/);
    });
  });

  it('getDisplayCodeFromToken returns same code as generation', () => {
    const { token, displayCode } = generateVoucherToken(testEmail);
    expect(getDisplayCodeFromToken(token)).toBe(displayCode);
  });

  it('getDisplayCodeFromToken returns null for malformed tokens', () => {
    expect(getDisplayCodeFromToken('')).toBeNull();
    expect(getDisplayCodeFromToken('not-a-token')).toBeNull();
    expect(getDisplayCodeFromToken('a:b:c:d:e')).toBeNull();
  });

  it('same email produces consistent display code for same token', () => {
    const { token, displayCode } = generateVoucherToken(testEmail);
    // Calling getDisplayCodeFromToken multiple times returns same result
    expect(getDisplayCodeFromToken(token)).toBe(displayCode);
    expect(getDisplayCodeFromToken(token)).toBe(displayCode);
  });

  // ---- generateVoucherUrl ----

  it('builds a URL with voucher query parameter', () => {
    const result = generateVoucherUrl(testEmail, 'https://app.test', 14);
    expect(result.url).toMatch(/^https:\/\/app\.test\?voucher=/);
    expect(result.url).toContain(encodeURIComponent(result.token));
    expect(result.displayCode).toBeTruthy();
    expect(result.expiresAt).toBeInstanceOf(Date);
  });

  it('appends with & when base URL already has query params', () => {
    const result = generateVoucherUrl(testEmail, 'https://app.test?ref=weekly', 14);
    expect(result.url).toMatch(/\?ref=weekly&voucher=/);
  });
});
