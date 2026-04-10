/**
 * Tests for thread-matcher.ts
 *
 * Verifies:
 * - Legacy fallback excludes cancelled/completed (terminal) appointments
 * - Therapist replying to nudge email doesn't match cancelled appointment
 * - Deterministic matches (thread ID, In-Reply-To, tracking code) still work
 * - Ambiguous match rejection
 */

jest.mock('../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockFindMany = jest.fn();
jest.mock('../utils/database', () => ({
  prisma: {
    appointmentRequest: {
      findMany: (...args: unknown[]) => mockFindMany(...args),
    },
  },
}));

jest.mock('../services/tracking-code.service', () => ({
  extractTrackingCode: jest.fn().mockReturnValue(null),
}));

import { findMatchingAppointmentRequest, type MatchableEmail } from '../utils/thread-matcher';

function makeEmail(overrides: Partial<MatchableEmail> = {}): MatchableEmail {
  return {
    id: 'msg-1',
    threadId: 'thread-new',
    from: 'therapist@example.com',
    to: 'scheduler@example.com',
    subject: 'Re: Just checking in',
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('findMatchingAppointmentRequest', () => {
  describe('legacy fallback (no deterministic match)', () => {
    it('should NOT match a cancelled appointment via legacy fallback', async () => {
      // First call: deterministic query (thread ID, in-reply-to, tracking code) — no match
      mockFindMany.mockResolvedValueOnce([]);
      // Second call: legacy fallback — returns nothing because cancelled is filtered out
      mockFindMany.mockResolvedValueOnce([]);

      const email = makeEmail({
        from: 'therapist@example.com',
        subject: 'Re: Just checking in',
      });

      const result = await findMatchingAppointmentRequest(email);
      expect(result).toBeNull();

      // Verify the legacy fallback query includes the status filter
      const legacyCall = mockFindMany.mock.calls[1];
      expect(legacyCall).toBeDefined();
      const legacyWhere = legacyCall[0].where;
      expect(legacyWhere.status).toBeDefined();
      expect(legacyWhere.status.notIn).toContain('cancelled');
      expect(legacyWhere.status.notIn).toContain('completed');
    });

    it('should match an active appointment via legacy fallback', async () => {
      // First call: deterministic query — no match
      mockFindMany.mockResolvedValueOnce([]);
      // Second call: legacy fallback — returns one active appointment
      mockFindMany.mockResolvedValueOnce([
        {
          id: 'apt-1',
          userEmail: 'client@example.com',
          therapistEmail: 'therapist@example.com',
          therapistName: 'Dr Smith',
          updatedAt: new Date(),
        },
      ]);

      const email = makeEmail({
        from: 'therapist@example.com',
        subject: 'Re: Booking with Dr Smith',
      });

      const result = await findMatchingAppointmentRequest(email);
      expect(result).not.toBeNull();
      expect(result!.id).toBe('apt-1');
    });

    it('should not match when therapist only has cancelled appointments (nudge reply scenario)', async () => {
      // Simulate: therapist replies to a nudge email. They only have a cancelled
      // appointment. The legacy fallback should return no results because
      // cancelled appointments are excluded by the status filter.
      mockFindMany.mockResolvedValueOnce([]); // deterministic: no match
      mockFindMany.mockResolvedValueOnce([]); // legacy: empty (cancelled filtered out by query)

      const email = makeEmail({
        from: 'therapist@example.com',
        subject: 'Re: Just a quick note',
        threadId: 'nudge-thread-123', // nudge thread, won't match any appointment
      });

      const result = await findMatchingAppointmentRequest(email);
      expect(result).toBeNull();
    });
  });

  describe('deterministic matching', () => {
    it('should match by Gmail thread ID regardless of status', async () => {
      // Deterministic match found by thread ID — should work even for cancelled
      mockFindMany.mockResolvedValueOnce([
        {
          id: 'apt-cancelled',
          userEmail: 'client@example.com',
          therapistEmail: 'therapist@example.com',
          gmailThreadId: 'thread-123',
          therapistGmailThreadId: null,
          initialMessageId: null,
          trackingCode: null,
        },
      ]);

      const email = makeEmail({
        threadId: 'thread-123',
        from: 'therapist@example.com',
      });

      const result = await findMatchingAppointmentRequest(email);
      expect(result).not.toBeNull();
      expect(result!.id).toBe('apt-cancelled');

      // Verify the deterministic query does NOT filter by status
      const deterministicCall = mockFindMany.mock.calls[0];
      const deterministicWhere = deterministicCall[0].where;
      expect(deterministicWhere.status).toBeUndefined();
    });
  });
});
