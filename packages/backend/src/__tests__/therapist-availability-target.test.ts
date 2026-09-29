/**
 * Tests for the target-appointment availability model in
 * therapist-booking-status.service.ts.
 *
 * Verifies:
 * - canAcceptNewRequest: manual freeze, continuation, serial guard,
 *   target-reached, and the available happy path.
 * - getUnavailableTherapistIds: frozen / busy / graduated therapists are
 *   excluded; live ones are not.
 * - Graduation is read from the durable therapist_completed_clients record
 *   (Therapist._count.completedClients), not from completed appointment
 *   rows — retention and admin delete remove those (review §3 #4).
 * - An appointment whose requester has not verified their email does not
 *   hold the therapist (review §3 #3).
 *
 * The appointment mocks evaluate the `where` clause against in-memory rows
 * so the verification filter is exercised, not just asserted.
 */

jest.mock('../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

type ApptRow = {
  id: string;
  therapistHandle: string;
  userEmail: string;
  status: string;
  emailVerifiedAt: Date | null;
};
let appointments: ApptRow[] = [];

type Where = Record<string, unknown>;
function matches(row: ApptRow, where: Where): boolean {
  for (const [key, cond] of Object.entries(where)) {
    const value = (row as unknown as Record<string, unknown>)[key];
    if (cond && typeof cond === 'object' && !(cond instanceof Date)) {
      const c = cond as { in?: unknown[]; not?: unknown };
      if (c.in && !c.in.includes(value)) return false;
      if ('not' in c && c.not === null && value === null) return false;
    } else if (value !== cond) {
      return false;
    }
  }
  return true;
}

const mockTherapistFindFirst = jest.fn();
const mockTherapistFindMany = jest.fn();
const mockStatusFindUnique = jest.fn();
const mockStatusFindMany = jest.fn();
const mockQueryRaw = jest.fn();

jest.mock('../utils/database', () => ({
  prisma: {
    therapist: {
      findFirst: (...a: unknown[]) => mockTherapistFindFirst(...a),
      findMany: (...a: unknown[]) => mockTherapistFindMany(...a),
    },
    therapistBookingStatus: {
      findUnique: (...a: unknown[]) => mockStatusFindUnique(...a),
      findMany: (...a: unknown[]) => mockStatusFindMany(...a),
    },
    appointmentRequest: {
      findFirst: async ({ where }: { where: Where }) =>
        appointments.find((r) => matches(r, where)) ?? null,
      findMany: async ({ where }: { where: Where & { therapistHandle: { in: string[] } } }) => {
        const { therapistHandle, ...rest } = where;
        const hits = appointments.filter(
          (r) => therapistHandle.in.includes(r.therapistHandle) && matches(r, rest),
        );
        return [...new Set(hits.map((r) => r.therapistHandle))].map((h) => ({ therapistHandle: h }));
      },
    },
    // Must NOT be used any more: counting completed appointment rows is the
    // bug. Returning a misleading 0 here proves the count comes from the
    // durable table instead.
    $queryRaw: (...a: unknown[]) => mockQueryRaw(...a),
  },
}));

jest.mock('../services/settings.service', () => ({
  getSettingValue: jest.fn().mockResolvedValue(2),
}));

import { therapistBookingStatusService } from '../services/therapist-booking-status.service';

const VERIFIED = new Date('2026-09-01T00:00:00Z');

beforeEach(() => {
  jest.clearAllMocks();
  appointments = [];
  mockQueryRaw.mockResolvedValue([{ count: 0 }]);
  mockStatusFindUnique.mockResolvedValue(null);
  mockStatusFindMany.mockResolvedValue([]);
});

function therapistWith(target: number, completedClients: number) {
  return { targetAppointments: target, _count: { completedClients } };
}

describe('canAcceptNewRequest (target model)', () => {
  it('rejects when the therapist is manually frozen', async () => {
    mockStatusFindUnique.mockResolvedValueOnce({ manualFreezeAt: new Date() });

    const result = await therapistBookingStatusService.canAcceptNewRequest('handle-1', 'user@x.com');
    expect(result).toEqual({ canAcceptNewRequests: false, reason: 'frozen' });
  });

  it('allows continuation when the same client already has an active, verified request', async () => {
    appointments = [
      { id: 'mine', therapistHandle: 'handle-1', userEmail: 'user@x.com', status: 'negotiating', emailVerifiedAt: VERIFIED },
    ];

    const result = await therapistBookingStatusService.canAcceptNewRequest('handle-1', 'user@x.com');
    expect(result).toEqual({ canAcceptNewRequests: true, reason: 'available' });
  });

  it('rejects (in_session) when the therapist has an active, verified appointment with someone else', async () => {
    appointments = [
      { id: 'other', therapistHandle: 'handle-1', userEmail: 'other@x.com', status: 'confirmed', emailVerifiedAt: VERIFIED },
    ];

    const result = await therapistBookingStatusService.canAcceptNewRequest('handle-1', 'user@x.com');
    expect(result).toEqual({ canAcceptNewRequests: false, reason: 'in_session' });
  });

  it('an UNVERIFIED request from someone else does not put the therapist in session', async () => {
    // One unverified booking per therapist used to empty the finder.
    appointments = [
      { id: 'spam', therapistHandle: 'handle-1', userEmail: 'fake@x.com', status: 'pending', emailVerifiedAt: null },
    ];
    mockTherapistFindFirst.mockResolvedValueOnce(therapistWith(2, 0));

    const result = await therapistBookingStatusService.canAcceptNewRequest('handle-1', 'user@x.com');
    expect(result).toEqual({ canAcceptNewRequests: true, reason: 'available' });
  });

  it("a requester's own unverified row is not a continuation pass while a verified client holds the therapist", async () => {
    appointments = [
      { id: 'mine', therapistHandle: 'handle-1', userEmail: 'user@x.com', status: 'pending', emailVerifiedAt: null },
      { id: 'other', therapistHandle: 'handle-1', userEmail: 'other@x.com', status: 'confirmed', emailVerifiedAt: VERIFIED },
    ];

    const result = await therapistBookingStatusService.canAcceptNewRequest('handle-1', 'user@x.com');
    expect(result).toEqual({ canAcceptNewRequests: false, reason: 'in_session' });
  });

  it('rejects (target_reached) when distinct completed clients >= target', async () => {
    mockTherapistFindFirst.mockResolvedValueOnce(therapistWith(2, 2));

    const result = await therapistBookingStatusService.canAcceptNewRequest('handle-1', 'user@x.com');
    expect(result).toEqual({ canAcceptNewRequests: false, reason: 'target_reached' });
  });

  it('stays target_reached after the completed appointment rows are gone (retention / admin delete)', async () => {
    // No completed appointment rows exist any more ($queryRaw would say 0),
    // but the durable record says 2 distinct clients completed.
    mockTherapistFindFirst.mockResolvedValueOnce(therapistWith(2, 2));
    mockQueryRaw.mockResolvedValue([{ count: 0 }]);

    const result = await therapistBookingStatusService.canAcceptNewRequest('handle-1', 'user@x.com');
    expect(result).toEqual({ canAcceptNewRequests: false, reason: 'target_reached' });
    expect(mockQueryRaw).not.toHaveBeenCalled();
    // One query resolves both the target and the durable count.
    expect(mockTherapistFindFirst).toHaveBeenCalledWith({
      where: { OR: [{ notionId: 'handle-1' }, { id: 'handle-1' }] },
      select: { targetAppointments: true, _count: { select: { completedClients: true } } },
    });
  });

  it('allows when short of target with no active appointment', async () => {
    mockTherapistFindFirst.mockResolvedValueOnce(therapistWith(2, 1));

    const result = await therapistBookingStatusService.canAcceptNewRequest('handle-1', 'user@x.com');
    expect(result).toEqual({ canAcceptNewRequests: true, reason: 'available' });
  });

  it('falls back to the default target (and zero completions) when no Therapist row matches', async () => {
    mockTherapistFindFirst.mockResolvedValueOnce(null);

    const result = await therapistBookingStatusService.canAcceptNewRequest('ghost', 'user@x.com');
    expect(result).toEqual({ canAcceptNewRequests: true, reason: 'available' });
  });
});

describe('getUnavailableTherapistIds (target model)', () => {
  it('excludes frozen, busy, and graduated therapists but keeps live ones', async () => {
    // t1: manually frozen; t2 (handle n2): graduated (1 completed >= target 1);
    // t3: busy (active verified appt); t4: live; t5: only an UNVERIFIED request → live.
    mockTherapistFindMany.mockResolvedValueOnce([
      { id: 't1', notionId: null, targetAppointments: 2, _count: { completedClients: 0 } },
      { id: 't2', notionId: 'n2', targetAppointments: 1, _count: { completedClients: 1 } },
      { id: 't3', notionId: null, targetAppointments: 2, _count: { completedClients: 0 } },
      { id: 't4', notionId: null, targetAppointments: 2, _count: { completedClients: 1 } },
      { id: 't5', notionId: null, targetAppointments: 2, _count: { completedClients: 0 } },
    ]);
    mockStatusFindMany.mockResolvedValueOnce([{ id: 't1' }]); // frozen
    appointments = [
      { id: 'a3', therapistHandle: 't3', userEmail: 'c@x.com', status: 'confirmed', emailVerifiedAt: VERIFIED },
      { id: 'a5', therapistHandle: 't5', userEmail: 'd@x.com', status: 'pending', emailVerifiedAt: null },
    ];

    const unavailable = await therapistBookingStatusService.getUnavailableTherapistIds();

    expect(unavailable.sort()).toEqual(['n2', 't1', 't3'].sort());
    expect(unavailable).not.toContain('t4');
    expect(unavailable).not.toContain('t5');
    expect(mockQueryRaw).not.toHaveBeenCalled();
  });
});

describe('getCompletedClientCounts', () => {
  it('reads the durable count and keys it by whichever handle form the caller passed', async () => {
    mockTherapistFindMany.mockResolvedValueOnce([
      { id: 'uuid-a', notionId: 'notion-a', _count: { completedClients: 3 } },
      { id: 'uuid-b', notionId: null, _count: { completedClients: 1 } },
    ]);

    const counts = await therapistBookingStatusService.getCompletedClientCounts(['notion-a', 'uuid-b']);

    expect(counts.get('notion-a')).toBe(3);
    expect(counts.get('uuid-b')).toBe(1);
    expect(counts.has('uuid-a')).toBe(false);
    expect(mockQueryRaw).not.toHaveBeenCalled();
  });
});
