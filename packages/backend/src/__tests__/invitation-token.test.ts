/**
 * Tests for the invitation-token utility.
 */

import {
  generateInvitationToken,
  hashInvitationToken,
  isWellFormedInvitationToken,
  buildInvitationUrl,
} from '../utils/invitation-token';

describe('invitation-token', () => {
  describe('generateInvitationToken', () => {
    it('produces a 64-char hex token and matching sha256 hash', () => {
      const { raw, hash } = generateInvitationToken();
      expect(raw).toMatch(/^[a-f0-9]{64}$/);
      expect(hash).toMatch(/^[a-f0-9]{64}$/);
      expect(hashInvitationToken(raw)).toBe(hash);
    });

    it('returns distinct tokens on repeat calls', () => {
      const a = generateInvitationToken();
      const b = generateInvitationToken();
      expect(a.raw).not.toBe(b.raw);
      expect(a.hash).not.toBe(b.hash);
    });
  });

  describe('hashInvitationToken', () => {
    it('is deterministic', () => {
      const raw = 'a'.repeat(64);
      expect(hashInvitationToken(raw)).toBe(hashInvitationToken(raw));
    });

    it('produces different hashes for tokens that differ by one character', () => {
      const a = 'a'.repeat(64);
      const b = 'a'.repeat(63) + 'b';
      expect(hashInvitationToken(a)).not.toBe(hashInvitationToken(b));
    });
  });

  describe('isWellFormedInvitationToken', () => {
    it('accepts a freshly generated token', () => {
      const { raw } = generateInvitationToken();
      expect(isWellFormedInvitationToken(raw)).toBe(true);
    });

    it('rejects tokens of wrong length', () => {
      expect(isWellFormedInvitationToken('abc')).toBe(false);
      expect(isWellFormedInvitationToken('a'.repeat(63))).toBe(false);
      expect(isWellFormedInvitationToken('a'.repeat(65))).toBe(false);
    });

    it('rejects non-hex characters', () => {
      expect(isWellFormedInvitationToken('z'.repeat(64))).toBe(false);
      expect(isWellFormedInvitationToken('A'.repeat(64))).toBe(false); // uppercase
    });

    it('rejects null/undefined/empty', () => {
      expect(isWellFormedInvitationToken(null)).toBe(false);
      expect(isWellFormedInvitationToken(undefined)).toBe(false);
      expect(isWellFormedInvitationToken('')).toBe(false);
    });
  });

  describe('buildInvitationUrl', () => {
    it('appends the token as ?invite=', () => {
      expect(buildInvitationUrl('https://x.test', 'abc123')).toBe(
        'https://x.test/signup?invite=abc123',
      );
    });

    it('strips a single trailing slash from baseUrl', () => {
      expect(buildInvitationUrl('https://x.test/', 'abc')).toBe(
        'https://x.test/signup?invite=abc',
      );
    });

    it('URL-encodes the token', () => {
      // Real tokens are pure hex so encoding is a no-op, but defend against
      // a future format change that introduces special chars.
      expect(buildInvitationUrl('https://x.test', 'a b/c')).toBe(
        'https://x.test/signup?invite=a%20b%2Fc',
      );
    });
  });
});
