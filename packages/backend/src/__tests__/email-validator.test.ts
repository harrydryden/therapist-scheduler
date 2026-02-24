/**
 * Tests for email validation utilities
 * Covers: normalizeEmail, isDisposableEmail, checkForTypos, validateEmail
 *
 * Note: MX record checks are not tested here as they require DNS lookups.
 * Those should be covered in integration tests.
 */

jest.mock('../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import {
  normalizeEmail,
  isDisposableEmail,
  checkForTypos,
  validateEmail,
} from '../utils/email-validator';

describe('normalizeEmail', () => {
  it('lowercases email', () => {
    expect(normalizeEmail('User@Example.COM')).toBe('user@example.com');
  });

  it('trims whitespace', () => {
    expect(normalizeEmail('  user@example.com  ')).toBe('user@example.com');
  });

  it('removes dots from gmail local part', () => {
    expect(normalizeEmail('john.doe@gmail.com')).toBe('johndoe@gmail.com');
  });

  it('removes gmail plus aliases', () => {
    expect(normalizeEmail('johndoe+spam@gmail.com')).toBe('johndoe@gmail.com');
  });

  it('normalizes googlemail.com to gmail.com', () => {
    expect(normalizeEmail('user@googlemail.com')).toBe('user@gmail.com');
  });

  it('does not remove dots for non-gmail domains', () => {
    expect(normalizeEmail('john.doe@outlook.com')).toBe('john.doe@outlook.com');
  });

  it('handles missing @ gracefully', () => {
    expect(normalizeEmail('invalid-email')).toBe('invalid-email');
  });
});

describe('isDisposableEmail', () => {
  it('detects mailinator.com', () => {
    expect(isDisposableEmail('test@mailinator.com')).toBe(true);
  });

  it('detects guerrillamail.com', () => {
    expect(isDisposableEmail('test@guerrillamail.com')).toBe(true);
  });

  it('detects tempmail.com', () => {
    expect(isDisposableEmail('test@tempmail.com')).toBe(true);
  });

  it('detects yopmail.com', () => {
    expect(isDisposableEmail('test@yopmail.com')).toBe(true);
  });

  it('detects pattern-based disposable domains', () => {
    expect(isDisposableEmail('test@10minutemail.xyz')).toBe(true);
    expect(isDisposableEmail('test@throwawaymail.net')).toBe(true);
  });

  it('returns false for legitimate domains', () => {
    expect(isDisposableEmail('user@gmail.com')).toBe(false);
    expect(isDisposableEmail('user@outlook.com')).toBe(false);
    expect(isDisposableEmail('user@company.co.uk')).toBe(false);
  });

  it('returns false for missing domain', () => {
    expect(isDisposableEmail('no-at-sign')).toBe(false);
  });
});

describe('checkForTypos', () => {
  it('suggests gmail.com for gmial.com', () => {
    expect(checkForTypos('user@gmial.com')).toBe('user@gmail.com');
  });

  it('suggests gmail.com for gmal.com', () => {
    expect(checkForTypos('user@gmal.com')).toBe('user@gmail.com');
  });

  it('suggests gmail.com for gmail.con', () => {
    expect(checkForTypos('user@gmail.con')).toBe('user@gmail.com');
  });

  it('suggests hotmail.com for hotmal.com', () => {
    expect(checkForTypos('user@hotmal.com')).toBe('user@hotmail.com');
  });

  it('suggests yahoo.com for yaho.com', () => {
    expect(checkForTypos('user@yaho.com')).toBe('user@yahoo.com');
  });

  it('suggests outlook.com for outlok.com', () => {
    expect(checkForTypos('user@outlok.com')).toBe('user@outlook.com');
  });

  it('returns null for correct domains', () => {
    expect(checkForTypos('user@gmail.com')).toBeNull();
    expect(checkForTypos('user@outlook.com')).toBeNull();
    expect(checkForTypos('user@yahoo.com')).toBeNull();
  });

  it('returns null for unknown domains', () => {
    expect(checkForTypos('user@mycompany.com')).toBeNull();
  });

  it('returns null for missing domain', () => {
    expect(checkForTypos('no-at-sign')).toBeNull();
  });
});

describe('validateEmail', () => {
  it('validates correct email format', async () => {
    const result = await validateEmail('user@gmail.com', {
      checkMx: false,
      blockDisposable: false,
    });
    expect(result.isValid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('rejects invalid email format', async () => {
    const result = await validateEmail('not-an-email', {
      checkMx: false,
      blockDisposable: false,
    });
    expect(result.isValid).toBe(false);
    expect(result.errors).toContain('Invalid email format');
  });

  it('rejects email without @', async () => {
    const result = await validateEmail('nodomain', { checkMx: false });
    expect(result.isValid).toBe(false);
  });

  it('rejects email without TLD', async () => {
    const result = await validateEmail('user@domain', { checkMx: false });
    expect(result.isValid).toBe(false);
  });

  it('blocks disposable emails when enabled', async () => {
    const result = await validateEmail('test@mailinator.com', {
      checkMx: false,
      blockDisposable: true,
    });
    expect(result.isValid).toBe(false);
    expect(result.isDisposable).toBe(true);
    expect(result.errors[0]).toContain('Disposable');
  });

  it('allows disposable emails when disabled', async () => {
    const result = await validateEmail('test@mailinator.com', {
      checkMx: false,
      blockDisposable: false,
    });
    expect(result.isValid).toBe(true);
  });

  it('includes typo suggestions', async () => {
    const result = await validateEmail('user@gmial.com', {
      checkMx: false,
      blockDisposable: false,
      suggestTypos: true,
    });
    expect(result.suggestions.length).toBeGreaterThan(0);
    expect(result.suggestions[0]).toContain('gmail.com');
  });

  it('normalizes email in result', async () => {
    const result = await validateEmail('User@Gmail.COM', {
      checkMx: false,
      blockDisposable: false,
    });
    expect(result.normalizedEmail).toBe('user@gmail.com');
  });
});
