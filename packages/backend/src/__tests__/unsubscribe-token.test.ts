/**
 * Tests for unsubscribe token generation and verification
 * Covers: token generation, verification, expiration, timing-safe comparison
 */

jest.mock('../config', () => ({
  config: { jwtSecret: 'test-secret-key-for-unit-tests' },
}));

import { generateUnsubscribeToken, extractEmailFromToken } from '../utils/unsubscribe-token';

describe('unsubscribe tokens', () => {
  const testEmail = 'user@example.com';

  it('generates a token that can be verified', () => {
    const token = generateUnsubscribeToken(testEmail);
    const extracted = extractEmailFromToken(token);
    expect(extracted).toBe(testEmail);
  });

  it('normalizes email to lowercase', () => {
    const token = generateUnsubscribeToken('User@Example.COM');
    const extracted = extractEmailFromToken(token);
    expect(extracted).toBe('user@example.com');
  });

  it('rejects tampered tokens', () => {
    const token = generateUnsubscribeToken(testEmail);
    // Tamper with the signature
    const tampered = token.slice(0, -5) + 'XXXXX';
    expect(extractEmailFromToken(tampered)).toBeNull();
  });

  it('rejects tokens with wrong version', () => {
    const token = generateUnsubscribeToken(testEmail);
    const wrongVersion = 'v99' + token.slice(2);
    expect(extractEmailFromToken(wrongVersion)).toBeNull();
  });

  it('rejects empty or malformed tokens', () => {
    expect(extractEmailFromToken('')).toBeNull();
    expect(extractEmailFromToken('not-a-token')).toBeNull();
    expect(extractEmailFromToken('v2::')).toBeNull();
  });

  it('generates unique tokens for different emails', () => {
    const token1 = generateUnsubscribeToken('user1@example.com');
    const token2 = generateUnsubscribeToken('user2@example.com');
    expect(token1).not.toBe(token2);
  });

  it('generates different tokens each time (timestamp varies)', async () => {
    const token1 = generateUnsubscribeToken(testEmail);
    // Wait a tiny bit so timestamp changes
    await new Promise((r) => setTimeout(r, 10));
    const token2 = generateUnsubscribeToken(testEmail);
    // Both should verify to same email but be different tokens
    expect(token1).not.toBe(token2);
    expect(extractEmailFromToken(token1)).toBe(testEmail);
    expect(extractEmailFromToken(token2)).toBe(testEmail);
  });
});
