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
const mockFindFirst = jest.fn();
const mockConvoFindMany = jest.fn();
jest.mock('../utils/database', () => ({
  prisma: {
    appointmentRequest: {
      findMany: (...args: unknown[]) => mockFindMany(...args),
      findFirst: (...args: unknown[]) => mockFindFirst(...args),
    },
    therapistConversation: {
      findMany: (...args: unknown[]) => mockConvoFindMany(...args),
    },
  },
}));

jest.mock('../services/tracking-code.service', () => ({
  extractTrackingCode: jest.fn().mockReturnValue(null),
}));

import {
  findMatchingAppointmentRequest,
  findMatchingTherapistConversation,
  type MatchableEmail,
} from '../utils/thread-matcher';

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
  // By default the cross-pollination guard finds no recent terminal appointments.
  mockFindFirst.mockResolvedValue(null);
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

  describe('cross-pollination guard (legacy fallback)', () => {
    it('rejects as ambiguous when sender has both active and recent terminal appointments', async () => {
      // Reproduces the SPL-8449 / SPL-1185 misroute: therapist has a recent
      // completed appointment with one client and a new active appointment
      // with another. An unstructured email from them must NOT be silently
      // attributed to the only active row.
      mockFindMany.mockResolvedValueOnce([]); // deterministic: no match
      mockFindMany.mockResolvedValueOnce([
        // Legacy fallback: one active appointment for this therapist
        {
          id: 'apt-maria-pending',
          userEmail: 'maria@example.com',
          therapistEmail: 'therapist@example.com',
          therapistName: 'Dr Smith',
          updatedAt: new Date(),
        },
      ]);
      // Cross-pollination guard finds a recent terminal appointment too
      mockFindFirst.mockResolvedValueOnce({ id: 'apt-harry-completed' });

      const email = makeEmail({
        from: 'therapist@example.com',
        subject: 'Following up',
      });

      const result = await findMatchingAppointmentRequest(email);
      expect(result).toBeNull();

      // The findFirst call should be filtering for terminal status with a recent updatedAt
      expect(mockFindFirst).toHaveBeenCalledTimes(1);
      const guardWhere = mockFindFirst.mock.calls[0][0].where;
      expect(guardWhere.status.in).toEqual(expect.arrayContaining(['completed', 'cancelled']));
      expect(guardWhere.updatedAt.gte).toBeInstanceOf(Date);
    });

    it('still matches the active appointment when no recent terminal exists', async () => {
      // Sanity check: the guard should not interfere with the normal happy path.
      mockFindMany.mockResolvedValueOnce([]); // deterministic: no match
      mockFindMany.mockResolvedValueOnce([
        {
          id: 'apt-active',
          userEmail: 'client@example.com',
          therapistEmail: 'therapist@example.com',
          therapistName: 'Dr Smith',
          updatedAt: new Date(),
        },
      ]);
      mockFindFirst.mockResolvedValueOnce(null); // no recent terminal

      const email = makeEmail({
        from: 'therapist@example.com',
        subject: 'Re: Booking',
      });

      const result = await findMatchingAppointmentRequest(email);
      expect(result).not.toBeNull();
      expect(result!.id).toBe('apt-active');
    });

    it('does not run the guard when the legacy query returns no candidates', async () => {
      // If there are no active appointments at all, the guard would be wasted
      // work — the function should short-circuit before querying for terminal
      // appointments.
      mockFindMany.mockResolvedValueOnce([]); // deterministic: no match
      mockFindMany.mockResolvedValueOnce([]); // legacy: empty

      const email = makeEmail({ from: 'therapist@example.com' });

      const result = await findMatchingAppointmentRequest(email);
      expect(result).toBeNull();
      expect(mockFindFirst).not.toHaveBeenCalled();
    });
  });

  describe('active-vs-active guard (forced-open therapist)', () => {
    it('rejects as ambiguous when a therapist has two active clients and the email has no deterministic marker', async () => {
      // Therapist is serving two different clients concurrently (forced open).
      // An unstructured reply from them (no thread id / In-Reply-To / tracking
      // code, no client-distinguishing subject) must NOT be attributed to the
      // most-recently-updated appointment — it is genuinely ambiguous.
      mockFindMany.mockResolvedValueOnce([]); // deterministic: no match
      mockFindMany.mockResolvedValueOnce([
        {
          id: 'apt-clientA',
          userEmail: 'clienta@example.com',
          therapistEmail: 'therapist@example.com',
          therapistName: 'Alex Smith',
          updatedAt: new Date('2026-07-10T10:00:00Z'),
        },
        {
          id: 'apt-clientB',
          userEmail: 'clientb@example.com',
          therapistEmail: 'therapist@example.com',
          therapistName: 'Alex Smith',
          updatedAt: new Date('2026-07-12T10:00:00Z'),
        },
      ]);
      mockFindFirst.mockResolvedValueOnce(null); // no recent terminal

      const email = makeEmail({
        from: 'therapist@example.com',
        subject: 'Quick question', // no therapist name, no client marker
      });

      const result = await findMatchingAppointmentRequest(email);
      expect(result).toBeNull();
    });

    it('rejects as ambiguous when the subject names the therapist but spans two clients', async () => {
      mockFindMany.mockResolvedValueOnce([]); // deterministic: no match
      mockFindMany.mockResolvedValueOnce([
        {
          id: 'apt-clientA',
          userEmail: 'clienta@example.com',
          therapistEmail: 'therapist@example.com',
          therapistName: 'Alex Smith',
          updatedAt: new Date('2026-07-10T10:00:00Z'),
        },
        {
          id: 'apt-clientB',
          userEmail: 'clientb@example.com',
          therapistEmail: 'therapist@example.com',
          therapistName: 'Alex Smith',
          updatedAt: new Date('2026-07-12T10:00:00Z'),
        },
      ]);
      mockFindFirst.mockResolvedValueOnce(null);

      const email = makeEmail({
        from: 'therapist@example.com',
        subject: 'Re: session with Alex Smith', // name matches BOTH candidates
      });

      const result = await findMatchingAppointmentRequest(email);
      expect(result).toBeNull();
    });

    it('still resolves when the tied active appointments are the SAME client (e.g. reschedule)', async () => {
      // Two active rows for one therapist but the SAME client — no misroute
      // risk, so most-recently-updated selection is retained.
      mockFindMany.mockResolvedValueOnce([]); // deterministic: no match
      mockFindMany.mockResolvedValueOnce([
        {
          id: 'apt-old',
          userEmail: 'client@example.com',
          therapistEmail: 'therapist@example.com',
          therapistName: 'Alex Smith',
          updatedAt: new Date('2026-07-10T10:00:00Z'),
        },
        {
          id: 'apt-new',
          userEmail: 'client@example.com',
          therapistEmail: 'therapist@example.com',
          therapistName: 'Alex Smith',
          updatedAt: new Date('2026-07-12T10:00:00Z'),
        },
      ]);
      mockFindFirst.mockResolvedValueOnce(null);

      const email = makeEmail({
        from: 'therapist@example.com',
        subject: 'Quick question',
      });

      const result = await findMatchingAppointmentRequest(email);
      expect(result).not.toBeNull();
      expect(result!.id).toBe('apt-new'); // most recently updated
    });
  });
});

describe('findMatchingTherapistConversation', () => {
  beforeEach(() => {
    mockConvoFindMany.mockReset();
  });

  function convoCandidate(overrides: {
    id?: string;
    therapistId?: string;
    status?: 'active' | 'completed' | 'superseded' | 'abandoned';
    supersededAckSent?: boolean;
    kind?: 'onboarding' | 'nudge_reply';
    gmailThreadId?: string | null;
    initialMessageId?: string | null;
    lastActivityAt?: Date;
    therapistEmail?: string;
  } = {}) {
    return {
      id: overrides.id ?? 'convo-1',
      therapistId: overrides.therapistId ?? 'tx-1',
      status: overrides.status ?? 'active',
      supersededAckSent: overrides.supersededAckSent ?? false,
      kind: overrides.kind ?? 'onboarding',
      gmailThreadId: overrides.gmailThreadId ?? 'thread-abc',
      initialMessageId: overrides.initialMessageId ?? null,
      lastActivityAt: overrides.lastActivityAt ?? new Date(),
      therapist: { email: overrides.therapistEmail ?? 'therapist@example.com' },
    };
  }

  it('returns the row when the inbound thread ID matches', async () => {
    mockConvoFindMany.mockResolvedValueOnce([convoCandidate()]);
    const result = await findMatchingTherapistConversation(
      makeEmail({ threadId: 'thread-abc' }),
    );
    expect(result).not.toBeNull();
    expect(result?.id).toBe('convo-1');
    expect(result?.status).toBe('active');
    expect(result?.therapistEmail).toBe('therapist@example.com');
  });

  it('returns null when no candidates match', async () => {
    mockConvoFindMany.mockResolvedValueOnce([]);
    const result = await findMatchingTherapistConversation(
      makeEmail({ threadId: 'thread-unknown' }),
    );
    expect(result).toBeNull();
  });

  it('matches via In-Reply-To when threadId is absent', async () => {
    mockConvoFindMany.mockResolvedValueOnce([
      convoCandidate({ gmailThreadId: null, initialMessageId: '<original@spill.chat>' }),
    ]);
    const result = await findMatchingTherapistConversation(
      makeEmail({ threadId: '', inReplyTo: '<original@spill.chat>' }),
    );
    expect(result?.id).toBe('convo-1');
  });

  it('returns null when neither threadId nor In-Reply-To/References are present', async () => {
    const result = await findMatchingTherapistConversation(
      makeEmail({ threadId: '', inReplyTo: undefined, references: undefined }),
    );
    // No DB query should fire if there's nothing deterministic to match on.
    expect(mockConvoFindMany).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });

  it('prefers an active candidate over a superseded one even if both match', async () => {
    // Both rows share the threadId (e.g. a therapist accidentally has
    // overlapping rows from history). The matcher must NOT silently
    // route the inbound through the terminal row.
    mockConvoFindMany.mockResolvedValueOnce([
      convoCandidate({
        id: 'convo-stale',
        status: 'superseded',
        supersededAckSent: true,
        lastActivityAt: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000),
      }),
      convoCandidate({
        id: 'convo-active',
        status: 'active',
        lastActivityAt: new Date(),
      }),
    ]);

    const result = await findMatchingTherapistConversation(
      makeEmail({ threadId: 'thread-abc' }),
    );
    expect(result?.id).toBe('convo-active');
    expect(result?.status).toBe('active');
  });

  it('returns the superseded row when no active candidate exists', async () => {
    mockConvoFindMany.mockResolvedValueOnce([
      convoCandidate({ id: 'convo-superseded', status: 'superseded' }),
    ]);
    const result = await findMatchingTherapistConversation(
      makeEmail({ threadId: 'thread-abc' }),
    );
    expect(result?.id).toBe('convo-superseded');
    expect(result?.status).toBe('superseded');
    // The dispatcher uses this signal to decide whether to fire the
    // one-shot ack — the matcher just reports the row.
    expect(result?.supersededAckSent).toBe(false);
  });
});
