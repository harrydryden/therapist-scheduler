import { describe, it, expect, vi, afterEach } from 'vitest';
import { describeLoginError, formatRetryAfter } from '../AuthContext';
import { AuthError, ApiError } from '../../api/core';

afterEach(() => {
  vi.useRealTimers();
});

describe('describeLoginError', () => {
  it('explains a wrong secret', () => {
    expect(describeLoginError(new AuthError('Unauthorized', 401))).toEqual({
      message: 'That admin secret is not correct.',
      lockedUntil: null,
    });
  });

  it('turns a 429 lockout into a message plus the time it lifts', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T12:00:00Z'));

    const state = describeLoginError(new AuthError('Too many failed authentication attempts.', 429, 300));

    expect(state.message).toMatch(/temporarily locked/);
    expect(state.lockedUntil).toBe(Date.parse('2026-01-01T12:05:00Z'));
  });

  it('says "try again later" for a lockout without Retry-After', () => {
    const state = describeLoginError(new AuthError('Too many', 429));
    expect(state.message).toMatch(/try again later/i);
    expect(state.lockedUntil).toBeNull();
  });

  it('passes other errors through', () => {
    expect(describeLoginError(new ApiError('Could not reach the server.')).message).toBe('Could not reach the server.');
    expect(describeLoginError('weird').message).toMatch(/sign-in failed/i);
  });
});

describe('formatRetryAfter', () => {
  it('formats seconds and rounds minutes up', () => {
    expect(formatRetryAfter(1)).toBe('1 second');
    expect(formatRetryAfter(42)).toBe('42 seconds');
    expect(formatRetryAfter(60)).toBe('about 1 minute');
    expect(formatRetryAfter(290)).toBe('about 5 minutes');
  });
});
