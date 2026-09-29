/**
 * Regression test for lifecycle audit L12 — "the tick promotes rows without
 * re-checking its query conditions atomically".
 *
 * The lifecycle tick SELECTS confirmed rows that are not mid-reschedule and
 * whose session ended more than an hour ago, but the promotion write in
 * transitions/light.ts only required `status = confirmed`. A reschedule
 * (initiate_reschedule) or a re-confirmation to a new future datetime
 * (mark_scheduling_complete) landing between the read and the write still
 * got promoted — a FUTURE session marked session_held, with no reminder or
 * meeting-link check to follow.
 *
 * Drives the REAL tick and the REAL light transition against a mocked Prisma
 * whose updateMany evaluates its WHERE clause against an in-memory row, so
 * the race is reproduced by mutating that row between findMany and
 * updateMany.
 */

jest.mock('../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// Inert base class — the real one wires Redis locks on construction.
jest.mock('../utils/locked-periodic-service', () => ({
  LockedPeriodicService: class {
    constructor(_cfg: unknown) {}
  },
}));

const onSessionHeldMock = jest.fn().mockResolvedValue(undefined);
jest.mock('../services/transition-side-effects.service', () => ({
  transitionSideEffectsService: {
    onSessionHeld: (...a: unknown[]) => onSessionHeldMock(...a),
    notifyTransition: jest.fn(),
  },
}));

const addAuditMessageMock = jest.fn().mockResolvedValue(undefined);
const recordStatusChangeEventMock = jest.fn().mockResolvedValue(undefined);
jest.mock('../domain/scheduling/lifecycle/audit', () => ({
  addAuditMessage: (...a: unknown[]) => addAuditMessageMock(...a),
  recordStatusChangeEvent: (...a: unknown[]) => recordStatusChangeEventMock(...a),
}));

jest.mock('../services/audit-event.service', () => ({
  auditEventService: { log: jest.fn().mockResolvedValue(undefined) },
}));

interface Row {
  id: string;
  status: string;
  userEmail: string;
  reschedulingInProgress: boolean;
  confirmedDateTimeParsed: Date | null;
  meetingLinkConfirmedAt: Date | null;
  confirmedDateTime: string | null;
}

let row: Row;
/** Mutation applied between the tick's read and its write (the race). */
let betweenReadAndWrite: ((r: Row) => void) | null = null;

type DateFilter = { not?: null; lt?: Date };
type Where = {
  id?: string;
  status?: string | { in: string[] };
  reschedulingInProgress?: boolean;
  confirmedDateTimeParsed?: DateFilter;
};

/** Minimal evaluator for the WHERE shapes the tick + light transition use. */
function matches(r: Row, where: Where): boolean {
  if (where.id !== undefined && where.id !== r.id) return false;
  if (typeof where.status === 'string' && where.status !== r.status) return false;
  if (typeof where.status === 'object' && !where.status.in.includes(r.status)) return false;
  if (where.reschedulingInProgress !== undefined && where.reschedulingInProgress !== r.reschedulingInProgress) {
    return false;
  }
  const dt = where.confirmedDateTimeParsed;
  if (dt) {
    if (dt.not === null && r.confirmedDateTimeParsed === null) return false;
    if (dt.lt && !(r.confirmedDateTimeParsed && r.confirmedDateTimeParsed < dt.lt)) return false;
  }
  return true;
}

const updateManyMock = jest.fn(async (args: { where: Where; data: { status: string } }) => {
  if (betweenReadAndWrite) {
    betweenReadAndWrite(row);
    betweenReadAndWrite = null;
  }
  if (!matches(row, args.where)) return { count: 0 };
  row.status = args.data.status;
  return { count: 1 };
});

jest.mock('../utils/database', () => ({
  prisma: {
    appointmentRequest: {
      findMany: jest.fn(async (args: { where: Where }) => (matches(row, args.where) ? [row] : [])),
      findUnique: jest.fn(async () => ({ id: row.id, status: row.status, userEmail: row.userEmail })),
      updateMany: (...a: unknown[]) => updateManyMock(...(a as [{ where: Where; data: { status: string } }])),
    },
  },
}));

import { logger } from '../utils/logger';
import { appointmentLifecycleTickService } from '../domain/scheduling/lifecycle/tick';
import { transitionToSessionHeld } from '../domain/scheduling/lifecycle/transitions/light';
import { InvalidTransitionError } from '../errors';

const runTick = () =>
  (appointmentLifecycleTickService as unknown as {
    tick: () => Promise<{ transitioned: number; unverifiedHeld: number }>;
  }).tick();

const HOUR = 60 * 60 * 1000;

beforeEach(() => {
  jest.clearAllMocks();
  betweenReadAndWrite = null;
  row = {
    id: 'apt-1',
    status: 'confirmed',
    userEmail: 'u@example.com',
    reschedulingInProgress: false,
    confirmedDateTimeParsed: new Date(Date.now() - 3 * HOUR), // session well over
    meetingLinkConfirmedAt: new Date(),
    confirmedDateTime: 'Mon 10am',
  };
});

describe('lifecycle tick — atomic re-check of its selection criteria (L12)', () => {
  it('promotes an eligible past session (baseline)', async () => {
    const result = await runTick();

    expect(result.transitioned).toBe(1);
    expect(row.status).toBe('session_held');
  });

  it('does NOT promote when a reschedule starts between the read and the write', async () => {
    betweenReadAndWrite = (r) => {
      r.reschedulingInProgress = true;
    };

    const result = await runTick();

    expect(row.status).toBe('confirmed');
    expect(result).toEqual({ transitioned: 0, unverifiedHeld: 0 });
    expect(onSessionHeldMock).not.toHaveBeenCalled();
    expect(recordStatusChangeEventMock).not.toHaveBeenCalled();
    // A lost race is not an error.
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('does NOT promote when the booking is re-confirmed to a future datetime between the read and the write', async () => {
    betweenReadAndWrite = (r) => {
      r.confirmedDateTimeParsed = new Date(Date.now() + 48 * HOUR);
    };

    const result = await runTick();

    expect(row.status).toBe('confirmed');
    expect(result.transitioned).toBe(0);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('the promotion write carries the same eligibility the tick selected on', async () => {
    await runTick();

    const where = updateManyMock.mock.calls[0][0].where;
    expect(where).toMatchObject({
      id: 'apt-1',
      status: { in: ['confirmed'] },
      reschedulingInProgress: false,
      confirmedDateTimeParsed: { not: null, lt: expect.any(Date) },
    });
  });
});

describe('transitionToSessionHeld — atomicWhere semantics', () => {
  it('admin/updateStatus callers (no atomicWhere) keep the status-only precondition', async () => {
    row.confirmedDateTimeParsed = new Date(Date.now() + 48 * HOUR);

    const result = await transitionToSessionHeld({ appointmentId: 'apt-1', source: 'admin', adminId: 'a' });

    expect(result).toMatchObject({ success: true, newStatus: 'session_held' });
    const where = updateManyMock.mock.calls[0][0].where;
    expect(where).not.toHaveProperty('reschedulingInProgress');
    expect(where).not.toHaveProperty('confirmedDateTimeParsed');
  });

  it('a caller precondition cannot widen the status guard', async () => {
    row.status = 'cancelled';

    await expect(
      transitionToSessionHeld({
        appointmentId: 'apt-1',
        source: 'system',
        atomicWhere: { status: 'cancelled' } as never,
      }),
    ).rejects.toBeInstanceOf(InvalidTransitionError);
    expect(row.status).toBe('cancelled');
  });

  it('still throws InvalidTransitionError when the status itself moved on', async () => {
    betweenReadAndWrite = (r) => {
      r.status = 'cancelled';
    };

    await expect(
      transitionToSessionHeld({
        appointmentId: 'apt-1',
        source: 'system',
        atomicWhere: { reschedulingInProgress: false },
      }),
    ).rejects.toBeInstanceOf(InvalidTransitionError);
  });
});
