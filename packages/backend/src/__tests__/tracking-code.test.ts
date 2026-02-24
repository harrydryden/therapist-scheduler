/**
 * Tests for tracking code utilities
 * Covers: extractTrackingCode, formatTrackingCodeForSubject, prependTrackingCodeToSubject
 *
 * Note: getOrCreateTrackingCode and database-dependent functions require integration tests.
 */

import {
  extractTrackingCode,
  formatTrackingCodeForSubject,
  prependTrackingCodeToSubject,
} from '../utils/tracking-code';

describe('extractTrackingCode', () => {
  describe('new format (SPL-XXXX-XXXX-N)', () => {
    it('extracts from subject line', () => {
      expect(extractTrackingCode('[SPL-1234-5678-1] Appointment Request')).toBe('SPL-1234-5678-1');
    });

    it('extracts without brackets', () => {
      expect(extractTrackingCode('Re: SPL-1234-5678-1 Appointment')).toBe('SPL-1234-5678-1');
    });

    it('extracts with multi-digit sequence number', () => {
      expect(extractTrackingCode('SPL-1234-5678-42')).toBe('SPL-1234-5678-42');
    });

    it('is case insensitive', () => {
      expect(extractTrackingCode('spl-1234-5678-1 Request')).toBe('SPL-1234-5678-1');
    });

    it('handles tracking code in middle of subject', () => {
      expect(extractTrackingCode('Re: FW: [SPL-9876-5432-3] Booking')).toBe('SPL-9876-5432-3');
    });
  });

  describe('legacy format (SPLN)', () => {
    it('extracts legacy SPL123 format', () => {
      expect(extractTrackingCode('Re: [SPL42] Appointment')).toBe('SPL42');
    });

    it('extracts SPL with multiple digits', () => {
      expect(extractTrackingCode('SPL1234 - Booking Request')).toBe('SPL1234');
    });

    it('is case insensitive for legacy format', () => {
      expect(extractTrackingCode('spl99 test')).toBe('SPL99');
    });
  });

  describe('no match', () => {
    it('returns null for no tracking code', () => {
      expect(extractTrackingCode('Regular email subject')).toBeNull();
    });

    it('returns null for empty string', () => {
      expect(extractTrackingCode('')).toBeNull();
    });

    it('returns null for SPL without digits', () => {
      expect(extractTrackingCode('SPL stuff')).toBeNull();
    });
  });

  describe('priority', () => {
    it('prefers new format over legacy when both present', () => {
      const result = extractTrackingCode('[SPL-1234-5678-1] was SPL42');
      expect(result).toBe('SPL-1234-5678-1');
    });
  });
});

describe('formatTrackingCodeForSubject', () => {
  it('wraps code in brackets', () => {
    expect(formatTrackingCodeForSubject('SPL-1234-5678-1')).toBe('[SPL-1234-5678-1]');
  });

  it('wraps legacy code in brackets', () => {
    expect(formatTrackingCodeForSubject('SPL42')).toBe('[SPL42]');
  });
});

describe('prependTrackingCodeToSubject', () => {
  it('prepends code to subject', () => {
    const result = prependTrackingCodeToSubject('Appointment Request', 'SPL-1234-5678-1');
    expect(result).toBe('[SPL-1234-5678-1] Appointment Request');
  });

  it('does not duplicate if code already in subject', () => {
    const subject = '[SPL-1234-5678-1] Appointment Request';
    const result = prependTrackingCodeToSubject(subject, 'SPL-1234-5678-1');
    expect(result).toBe(subject);
  });

  it('is case insensitive when checking for existing code', () => {
    const subject = '[spl-1234-5678-1] Appointment Request';
    const result = prependTrackingCodeToSubject(subject, 'SPL-1234-5678-1');
    expect(result).toBe(subject);
  });

  it('handles legacy format codes', () => {
    const result = prependTrackingCodeToSubject('Booking', 'SPL42');
    expect(result).toBe('[SPL42] Booking');
  });
});
