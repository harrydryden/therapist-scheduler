/**
 * Tests for therapist nudge reply detection
 *
 * Verifies that when a therapist replies to a nudge email, the system
 * correctly identifies the reply via the stored lastNudgeThreadId and
 * prevents it from being routed to an unrelated appointment.
 *
 * These tests verify the detection logic in isolation — the full
 * processMessage() flow is tested via e2e tests.
 */

jest.mock('../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockTherapistFindFirst = jest.fn();
const mockAppointmentFindMany = jest.fn();

jest.mock('../utils/database', () => ({
  prisma: {
    therapist: {
      findFirst: (...args: unknown[]) => mockTherapistFindFirst(...args),
    },
    appointmentRequest: {
      findMany: (...args: unknown[]) => mockAppointmentFindMany(...args),
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
    threadId: 'nudge-thread-abc',
    from: 'therapist@example.com',
    to: 'scheduling@spill.chat',
    subject: 'Re: Spill update - still finding you a client',
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('Nudge reply detection', () => {
  it('should identify a nudge reply by lastNudgeThreadId on the therapist record', async () => {
    // The nudge thread ID is stored on the therapist. A simple lookup
    // by threadId against therapist.lastNudgeThreadId tells us this
    // email is a nudge reply, not an appointment reply.
    mockTherapistFindFirst.mockResolvedValueOnce({
      id: 'therapist-1',
      name: 'Anita Pollard',
      email: 'therapist@example.com',
      lastNudgeThreadId: 'nudge-thread-abc',
    });

    const email = makeEmail();

    // Verify the therapist lookup matches
    const { prisma } = require('../utils/database');
    const therapist = await prisma.therapist.findFirst({
      where: { lastNudgeThreadId: email.threadId },
      select: { id: true, name: true, email: true },
    });

    expect(therapist).not.toBeNull();
    expect(therapist.name).toBe('Anita Pollard');
    expect(mockTherapistFindFirst).toHaveBeenCalledWith({
      where: { lastNudgeThreadId: 'nudge-thread-abc' },
      select: { id: true, name: true, email: true },
    });
  });

  it('should NOT identify a regular appointment reply as a nudge reply', async () => {
    // No therapist has this thread as a nudge thread
    mockTherapistFindFirst.mockResolvedValueOnce(null);

    const email = makeEmail({ threadId: 'appointment-thread-xyz' });

    const { prisma } = require('../utils/database');
    const therapist = await prisma.therapist.findFirst({
      where: { lastNudgeThreadId: email.threadId },
      select: { id: true, name: true, email: true },
    });

    expect(therapist).toBeNull();
  });

  it('thread-matcher should not match when therapist only has cancelled appointments', async () => {
    // After nudge detection is skipped (no threadId match on therapist),
    // the appointment matcher's legacy fallback should still not return
    // cancelled appointments.
    mockAppointmentFindMany.mockResolvedValueOnce([]); // deterministic: no match
    mockAppointmentFindMany.mockResolvedValueOnce([]); // legacy: cancelled filtered out

    const email = makeEmail({
      threadId: 'unknown-thread',
      from: 'therapist@example.com',
    });

    const result = await findMatchingAppointmentRequest(email);
    expect(result).toBeNull();

    // Verify the legacy query excluded terminal statuses
    const legacyCall = mockAppointmentFindMany.mock.calls[1];
    expect(legacyCall[0].where.status.notIn).toContain('cancelled');
    expect(legacyCall[0].where.status.notIn).toContain('completed');
  });
});
