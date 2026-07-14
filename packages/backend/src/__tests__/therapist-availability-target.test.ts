/**
 * Tests for the target-appointment availability model in
 * therapist-booking-status.service.ts.
 *
 * Verifies:
 * - canAcceptNewRequest: manual freeze, continuation, serial guard,
 *   target-reached, and the available happy path.
 * - getUnavailableTherapistIds: frozen / busy / graduated therapists are
 *   excluded; live ones are not.
 */

jest.mock('../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockTherapistFindFirst = jest.fn();
const mockTherapistFindMany = jest.fn();
const mockStatusFindUnique = jest.fn();
const mockStatusFindMany = jest.fn();
const mockApptFindFirst = jest.fn();
const mockApptFindMany = jest.fn();
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
      findFirst: (...a: unknown[]) => mockApptFindFirst(...a),
      findMany: (...a: unknown[]) => mockApptFindMany(...a),
    },
    // Distinct completed-client counts run through $queryRaw (case-insensitive).
    $queryRaw: (...a: unknown[]) => mockQueryRaw(...a),
  },
}));

jest.mock('../services/settings.service', () => ({
  getSettingValue: jest.fn().mockResolvedValue(2),
}));

import { therapistBookingStatusService } from '../services/therapist-booking-status.service';

beforeEach(() => {
  jest.clearAllMocks();
});

describe('canAcceptNewRequest (target model)', () => {
  it('rejects when the therapist is manually frozen', async () => {
    mockStatusFindUnique.mockResolvedValueOnce({ manualFreezeAt: new Date() });

    const result = await therapistBookingStatusService.canAcceptNewRequest('handle-1', 'user@x.com');
    expect(result).toEqual({ canAcceptNewRequests: false, reason: 'frozen' });
  });

  it('allows continuation when the same client already has an active request', async () => {
    mockStatusFindUnique.mockResolvedValueOnce(null);
    mockApptFindFirst.mockResolvedValueOnce({ id: 'apt-existing' }); // continuation

    const result = await therapistBookingStatusService.canAcceptNewRequest('handle-1', 'user@x.com');
    expect(result).toEqual({ canAcceptNewRequests: true, reason: 'available' });
  });

  it('rejects (in_session) when the therapist has an active appointment with someone else', async () => {
    mockStatusFindUnique.mockResolvedValueOnce(null);
    mockApptFindFirst
      .mockResolvedValueOnce(null) // continuation: none for this client
      .mockResolvedValueOnce({ id: 'apt-other' }); // serial guard: active appt exists

    const result = await therapistBookingStatusService.canAcceptNewRequest('handle-1', 'user@x.com');
    expect(result).toEqual({ canAcceptNewRequests: false, reason: 'in_session' });
  });

  it('rejects (target_reached) when distinct completed clients >= target', async () => {
    mockStatusFindUnique.mockResolvedValueOnce(null);
    mockApptFindFirst
      .mockResolvedValueOnce(null) // continuation
      .mockResolvedValueOnce(null); // serial guard: no active appt
    mockTherapistFindFirst.mockResolvedValueOnce({ targetAppointments: 2 });
    mockQueryRaw.mockResolvedValueOnce([{ count: 2 }]); // 2 distinct completed clients

    const result = await therapistBookingStatusService.canAcceptNewRequest('handle-1', 'user@x.com');
    expect(result).toEqual({ canAcceptNewRequests: false, reason: 'target_reached' });
  });

  it('allows when short of target with no active appointment', async () => {
    mockStatusFindUnique.mockResolvedValueOnce(null);
    mockApptFindFirst
      .mockResolvedValueOnce(null) // continuation
      .mockResolvedValueOnce(null); // serial guard
    mockTherapistFindFirst.mockResolvedValueOnce({ targetAppointments: 2 });
    mockQueryRaw.mockResolvedValueOnce([{ count: 1 }]); // 1 < 2

    const result = await therapistBookingStatusService.canAcceptNewRequest('handle-1', 'user@x.com');
    expect(result).toEqual({ canAcceptNewRequests: true, reason: 'available' });
  });
});

describe('getUnavailableTherapistIds (target model)', () => {
  it('excludes frozen, busy, and graduated therapists but keeps live ones', async () => {
    // t1: manually frozen; t2 (handle n2): graduated (1 completed >= target 1);
    // t3: busy (active appt); t4: live (short of target, no active appt).
    mockTherapistFindMany.mockResolvedValueOnce([
      { id: 't1', notionId: null, targetAppointments: 2 },
      { id: 't2', notionId: 'n2', targetAppointments: 1 },
      { id: 't3', notionId: null, targetAppointments: 2 },
      { id: 't4', notionId: null, targetAppointments: 2 },
    ]);
    mockStatusFindMany.mockResolvedValueOnce([{ id: 't1' }]); // frozen
    mockApptFindMany.mockResolvedValueOnce([{ therapistHandle: 't3' }]); // busy
    mockQueryRaw.mockResolvedValueOnce([{ therapist_handle: 'n2', count: 1 }]); // n2: 1 completed >= target 1

    const unavailable = await therapistBookingStatusService.getUnavailableTherapistIds();

    expect(unavailable.sort()).toEqual(['n2', 't1', 't3'].sort());
    expect(unavailable).not.toContain('t4');
  });
});
