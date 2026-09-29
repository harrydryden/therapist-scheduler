/**
 * Settings the booking agent's prompt builder now honours.
 *
 * Conflict C7 (system review §6): slot DISPLAY used a hard-coded 4-hour
 * minimum lead time (MIN_BOOKING_LEAD_HOURS in windows/formatter.ts) while
 * mark_scheduling_complete's VALIDATION read the admin setting
 * `general.minBookingLeadHours`. Raise the setting to 24h and the agent
 * was still offered slots 5 hours out, which the confirmation then
 * refused. Both now read the setting: the prompt builder passes it to the
 * formatter.
 *
 * agent.holdingReplyOnEscalation: when on, flagging sends the person who
 * wrote in a holding reply automatically, so the prompt must stop telling
 * the agent to send its own (the client would get two).
 */

jest.mock('../utils/logger', () => require('./_global-mocks').loggerMock());
jest.mock('../config', () => ({ config: { env: 'test', timezone: 'Europe/London' } }));
jest.mock('../services/knowledge.service', () => ({
  knowledgeService: { getKnowledgeForPrompt: jest.fn().mockResolvedValue({ forTherapist: '', forUser: '' }) },
}));

const settingsMap = new Map<string, string | number>([
  ['email.initialClientWithAvailabilitySubject', 's'],
  ['email.initialClientWithAvailabilityBody', 'b'],
  ['email.initialTherapistWithAvailabilitySubject', 's'],
  ['email.initialTherapistWithAvailabilityBody', 'b'],
  ['email.initialTherapistNoAvailabilitySubject', 's'],
  ['email.initialTherapistNoAvailabilityBody', 'b'],
  ['email.slotConfirmationToTherapistSubject', 's'],
  ['email.slotConfirmationToTherapistBody', 'b'],
  ['agent.languageStyle', 'UK'],
  ['agent.toneStyle', 'warm-casual'],
  ['agent.fromName', 'Justin Time'],
  ['agent.sessionDurationMinutes', 50],
  ['agent.maxSlotsPerGroup', 6],
  ['agent.maxTotalSlots', 12],
  ['general.timezone', 'Europe/London'],
  ['general.minBookingLeadHours', 24],
]);
jest.mock('../services/settings.service', () => ({
  getSettingValues: jest.fn(async () => new Map(settingsMap)),
}));
jest.mock('../utils/database', () => ({
  prisma: {
    appointmentRequest: { findUnique: jest.fn().mockResolvedValue({ memory: null }) },
    user: { findUnique: jest.fn().mockResolvedValue(null) },
    therapist: { findUnique: jest.fn().mockResolvedValue(null) },
  },
}));
jest.mock('../core/timezone', () => ({
  ...jest.requireActual('../core/timezone'),
  buildTimezoneSection: jest.fn().mockReturnValue('TZ\n'),
}));
// Real formatter, wrapped so the builder's call can be inspected.
jest.mock('../domain/scheduling/availability/windows/formatter', () => {
  const actual = jest.requireActual('../domain/scheduling/availability/windows/formatter');
  return { ...actual, formatAvailabilityForUser: jest.fn((...a: unknown[]) => actual.formatAvailabilityForUser(...a)) };
});

import { formatAvailabilityForUser } from '../domain/scheduling/availability/windows/formatter';
import { buildSystemPrompt } from '../services/system-prompt-builder';
import type { SchedulingContext } from '../services/scheduling-context.service';

const AVAILABILITY = { timezone: 'Europe/London', slots: [{ day: 'Monday', start: '09:00', end: '18:00' }] };
// Monday 28 Sep 2026, 07:00 London (BST).
const MONDAY_7AM = new Date('2026-09-28T06:00:00Z');

describe('formatAvailabilityForUser honours the lead time it is given', () => {
  it('defaults to 4 hours (the setting default)', () => {
    const result = formatAvailabilityForUser(AVAILABILITY, 'Europe/London', MONDAY_7AM);
    // 07:00 + 4h = 11:00 → first offered slot is 12:00 the same Monday.
    expect(result.soonestSlot!.datetime.toISOString()).toBe('2026-09-28T11:00:00.000Z');
  });

  it('with a 24-hour lead, nothing sooner than a day out is offered', () => {
    const result = formatAvailabilityForUser(AVAILABILITY, 'Europe/London', MONDAY_7AM, { minBookingLeadHours: 24 });
    expect(result.soonestSlot!.datetime.toISOString()).toBe('2026-10-05T08:00:00.000Z'); // next Monday 09:00
    const all = [...result.thisWeek, ...result.nextWeek, ...result.later];
    expect(all.every((s) => s.datetime.getTime() > MONDAY_7AM.getTime() + 24 * 3600_000)).toBe(true);
  });
});

describe('buildSystemPrompt passes general.minBookingLeadHours to the formatter', () => {
  it('uses the admin setting, not the hard-coded constant', async () => {
    const context = {
      appointmentRequestId: 'apt-1',
      userName: 'Maria',
      userEmail: 'maria@example.com',
      therapistEmail: 'dr@example.com',
      therapistName: 'Jones',
      therapistAvailability: AVAILABILITY,
      bookingMethod: 'agent_negotiated',
      userCountry: 'UK',
      therapistCountry: 'UK',
    } as SchedulingContext;

    await buildSystemPrompt(context);

    const slotConfig = (formatAvailabilityForUser as jest.Mock).mock.calls.at(-1)[3];
    expect(slotConfig.minBookingLeadHours).toBe(24);
  });
});

describe('holding-reply guidance follows agent.holdingReplyOnEscalation', () => {
  const context = {
    appointmentRequestId: 'apt-1',
    userName: 'Maria',
    userEmail: 'maria@example.com',
    therapistEmail: 'dr@example.com',
    therapistName: 'Jones',
    therapistAvailability: null,
    bookingMethod: 'agent_negotiated',
    userCountry: 'UK',
    therapistCountry: 'UK',
  } as SchedulingContext;

  afterEach(() => settingsMap.delete('agent.holdingReplyOnEscalation'));

  it('on: tells the agent not to send its own holding reply', async () => {
    settingsMap.set('agent.holdingReplyOnEscalation', true as unknown as number);
    const prompt = await buildSystemPrompt(context);
    expect(prompt).toContain('Do not send a holding reply yourself');
    expect(prompt).not.toContain('You may send a brief holding reply');
  });

  it('off: the agent may send one itself', async () => {
    settingsMap.set('agent.holdingReplyOnEscalation', false as unknown as number);
    const prompt = await buildSystemPrompt(context);
    expect(prompt).toContain('You may send a brief holding reply');
    expect(prompt).not.toContain('Do not send a holding reply yourself');
  });
});
