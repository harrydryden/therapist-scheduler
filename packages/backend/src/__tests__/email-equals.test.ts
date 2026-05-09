/**
 * Tests for the centralised email comparison util used by the agent's
 * sender-attribution path. Strict-equality classification of the From
 * header lets a mixed-case sender bypass user/therapist routing.
 */

import { emailEquals, normalizeEmail } from '../utils/email-equals';

describe('emailEquals', () => {
  it('matches identical addresses', () => {
    expect(emailEquals('a@b.com', 'a@b.com')).toBe(true);
  });

  it('matches case-insensitively', () => {
    expect(emailEquals('User@Example.COM', 'user@example.com')).toBe(true);
    expect(emailEquals('USER@EXAMPLE.COM', 'user@example.com')).toBe(true);
  });

  it('trims surrounding whitespace before comparing', () => {
    expect(emailEquals('  user@example.com', 'user@example.com  ')).toBe(true);
  });

  it('returns false for non-matching addresses', () => {
    expect(emailEquals('a@b.com', 'c@b.com')).toBe(false);
  });

  it('returns false when either side is empty/null/undefined', () => {
    expect(emailEquals('a@b.com', '')).toBe(false);
    expect(emailEquals('', 'a@b.com')).toBe(false);
    expect(emailEquals(null, 'a@b.com')).toBe(false);
    expect(emailEquals(undefined, 'a@b.com')).toBe(false);
    expect(emailEquals(null, null)).toBe(false);
  });
});

describe('normalizeEmail', () => {
  it('lowercases and trims', () => {
    expect(normalizeEmail('  USER@Example.com ')).toBe('user@example.com');
  });

  it('returns empty string for null/undefined', () => {
    expect(normalizeEmail(null)).toBe('');
    expect(normalizeEmail(undefined)).toBe('');
  });
});
