/**
 * Tests for the appointment-lifecycle tick's meeting-link truth gate.
 *
 * The tick promotes confirmed → session_held once the session time has
 * passed. Previously it did so purely on the clock, silently asserting that
 * sessions occurred even when no meeting link was ever set up. The gate
 * keeps the transition (blocking on a heuristic would strand legitimate
 * out-of-band bookings) but distinguishes verified from unverified holds:
 * unverified ones are logged loudly and written to the audit trail via a
 * dedicated `session_held_unverified` event so an admin can confirm the
 * session before the feedback flow runs.
 */

jest.mock('../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// Inert base class — the real one wires Redis locks on construction, which
// the singleton export would trigger at import time.
jest.mock('../utils/locked-periodic-service', () => ({
  LockedPeriodicService: class {
    constructor(_cfg: unknown) {}
  },
}));

const appointmentFindMany = jest.fn();
jest.mock('../utils/database', () => ({
  prisma: {
    appointmentRequest: {
      findMany: (...a: unknown[]) => appointmentFindMany(...a),
    },
  },
}));

const transitionToSessionHeld = jest.fn();
jest.mock('../domain/scheduling/lifecycle/transitions/light', () => ({
  transitionToSessionHeld: (...a: unknown[]) => transitionToSessionHeld(...a),
}));

const auditLog = jest.fn().mockResolvedValue(undefined);
jest.mock('../services/audit-event.service', () => ({
  auditEventService: {
    log: (...a: unknown[]) => auditLog(...a),
  },
}));

import { appointmentLifecycleTickService } from '../domain/scheduling/lifecycle/tick';

// The tick() method is protected; reach it directly for the unit test.
const runTick = () =>
  (appointmentLifecycleTickService as unknown as { tick: () => Promise<{ transitioned: number; unverifiedHeld: number }> }).tick();

beforeEach(() => {
  jest.clearAllMocks();
  // Default: every transition succeeds (not idempotently skipped).
  transitionToSessionHeld.mockResolvedValue({ skipped: false });
});

describe('appointment-lifecycle tick — meeting-link truth gate', () => {
  it('returns zero counts and does nothing when there are no due appointments', async () => {
    appointmentFindMany.mockResolvedValueOnce([]);

    const result = await runTick();

    expect(result).toEqual({ transitioned: 0, unverifiedHeld: 0 });
    expect(transitionToSessionHeld).not.toHaveBeenCalled();
    expect(auditLog).not.toHaveBeenCalled();
  });

  it('selects the meeting-link verification field for the truth gate', async () => {
    appointmentFindMany.mockResolvedValueOnce([]);
    await runTick();
    const query = appointmentFindMany.mock.calls[0][0];
    expect(query.select).toMatchObject({ meetingLinkConfirmedAt: true });
  });

  it('counts a verified hold as transitioned without an unverified audit', async () => {
    appointmentFindMany.mockResolvedValueOnce([
      { id: 'apt-verified', meetingLinkConfirmedAt: new Date('2026-06-20T10:00:00Z'), confirmedDateTime: 'Tue 16 June 11am' },
    ]);

    const result = await runTick();

    expect(result).toEqual({ transitioned: 1, unverifiedHeld: 0 });
    expect(transitionToSessionHeld).toHaveBeenCalledWith({ appointmentId: 'apt-verified', source: 'system' });
    expect(auditLog).not.toHaveBeenCalled();
  });

  it('flags an unverified hold: still transitions, but logs a session_held_unverified audit event', async () => {
    appointmentFindMany.mockResolvedValueOnce([
      { id: 'apt-unverified', meetingLinkConfirmedAt: null, confirmedDateTime: 'Tue 16 June 11am' },
    ]);

    const result = await runTick();

    // Still transitions — we don't block on a heuristic signal.
    expect(transitionToSessionHeld).toHaveBeenCalledWith({ appointmentId: 'apt-unverified', source: 'system' });
    expect(result).toEqual({ transitioned: 1, unverifiedHeld: 1 });

    // ...but leaves an audit trail so the unverified hold is visible.
    expect(auditLog).toHaveBeenCalledTimes(1);
    const [appointmentId, eventType, actor, payload] = auditLog.mock.calls[0];
    expect(appointmentId).toBe('apt-unverified');
    expect(eventType).toBe('session_held_unverified');
    expect(actor).toBe('system');
    expect(payload).toMatchObject({ confirmedDateTime: 'Tue 16 June 11am' });
    expect(payload.note).toMatch(/no meeting link/i);
  });

  it('handles a mixed batch — only the unverified one is audited', async () => {
    appointmentFindMany.mockResolvedValueOnce([
      { id: 'apt-ok', meetingLinkConfirmedAt: new Date(), confirmedDateTime: 'Mon 11am' },
      { id: 'apt-bad', meetingLinkConfirmedAt: null, confirmedDateTime: 'Wed 2pm' },
    ]);

    const result = await runTick();

    expect(result).toEqual({ transitioned: 2, unverifiedHeld: 1 });
    expect(auditLog).toHaveBeenCalledTimes(1);
    expect(auditLog.mock.calls[0][0]).toBe('apt-bad');
  });

  it('does not count or audit idempotently-skipped transitions', async () => {
    appointmentFindMany.mockResolvedValueOnce([
      { id: 'apt-skip', meetingLinkConfirmedAt: null, confirmedDateTime: 'Fri 9am' },
    ]);
    transitionToSessionHeld.mockResolvedValueOnce({ skipped: true });

    const result = await runTick();

    // Skipped (a concurrent writer already moved it) — neither transitioned
    // nor flagged as an unverified hold.
    expect(result).toEqual({ transitioned: 0, unverifiedHeld: 0 });
    expect(auditLog).not.toHaveBeenCalled();
  });
});
