/**
 * Pins the shared SchedulingContext relation `include` + the
 * buildSchedulingContext mapping.
 *
 * Regression: `processEmailReply` hand-rolled a `findUnique` include that
 * selected only `country` on the nested user/therapist relations, NOT
 * `timezone`. buildSchedulingContext then read `user.timezone` /
 * `therapist.timezone` as `undefined`, so the system-prompt timezone
 * section rendered "unknown — you MUST ask" on every email reply even
 * after `record_user_timezone` / `record_therapist_timezone` had persisted
 * the zone — silently defeating those tools across turns.
 *
 * The fix consolidates the include shape into one exported constant used by
 * both fetchSchedulingContext and processEmailReply. This file locks in:
 *   1. the constant selects BOTH country and timezone for each relation, and
 *   2. buildSchedulingContext propagates the recorded timezone into context.
 */

jest.mock('../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('../utils/database', () => ({
  prisma: { appointmentRequest: { findUnique: jest.fn() } },
}));

import {
  SCHEDULING_CONTEXT_RELATIONS_INCLUDE,
  buildSchedulingContext,
} from '../services/scheduling-context.service';

describe('SCHEDULING_CONTEXT_RELATIONS_INCLUDE', () => {
  it('selects both country AND timezone for the user relation', () => {
    expect(SCHEDULING_CONTEXT_RELATIONS_INCLUDE.user).toEqual({
      select: { country: true, timezone: true },
    });
  });

  it('selects both country AND timezone for the therapist relation', () => {
    expect(SCHEDULING_CONTEXT_RELATIONS_INCLUDE.therapist).toEqual({
      select: { country: true, timezone: true },
    });
  });
});

describe('buildSchedulingContext — timezone propagation', () => {
  const baseRow = {
    id: 'apt-1',
    userName: 'Alice Smith',
    userEmail: 'alice@example.com',
    userId: 'user-1',
    therapistEmail: 't@example.com',
    therapistName: 'Dr Taylor',
    therapistId: 'th-1',
    therapistAvailability: null,
    bookingMethod: 'agent_negotiated',
  };

  it('propagates the recorded user/therapist timezone into the context', () => {
    const context = buildSchedulingContext({
      ...baseRow,
      user: { country: 'US', timezone: 'America/Los_Angeles' },
      therapist: { country: 'AU', timezone: 'Australia/Sydney' },
    });

    expect(context.userTimezone).toBe('America/Los_Angeles');
    expect(context.therapistTimezone).toBe('Australia/Sydney');
    expect(context.userCountry).toBe('US');
    expect(context.therapistCountry).toBe('AU');
  });

  it('leaves timezone undefined when the column is null (fallback chain handles it)', () => {
    const context = buildSchedulingContext({
      ...baseRow,
      user: { country: 'UK', timezone: null },
      therapist: { country: 'UK', timezone: null },
    });

    expect(context.userTimezone).toBeUndefined();
    expect(context.therapistTimezone).toBeUndefined();
  });
});
