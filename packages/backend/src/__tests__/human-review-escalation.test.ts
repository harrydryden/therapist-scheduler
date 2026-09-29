/**
 * Escalation to human review (domain/scheduling/agent/handlers/human-control.ts):
 *
 *   A12a  Slack alerts were deduped for 24h per appointment under one
 *         shared 'human-control' group, so an appointment re-paused after
 *         an admin released it produced no alert for a day. Now deduped on
 *         (appointment, reason) within a short window
 *         (admin-notification.service).
 *   A12b  When a guard tripped or the agent flagged, the client/therapist
 *         who wrote in heard nothing. Now they get a holding reply (behind
 *         agent.holdingReplyOnEscalation), at most once per escalation,
 *         through the agent's outbound path, never to an unverified sender.
 *
 * The Slack fake reproduces SlackAlertOptions' documented appointment-
 * scoped dedup contract (one alert per `dedupGroup || title` per
 * appointment per 24h), which is what silenced the re-pause before.
 */

jest.mock('../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../config', () => ({ config: { env: 'test' } }));

let clock = Date.parse('2026-09-28T09:00:00Z');
const DAY_MS = 24 * 60 * 60 * 1000;

// Slack: emulate the appointment-scoped 24h dedup layer.
const slackKeys = new Map<string, number>();
const delivered: Array<{ title: string; details: string; dedupGroup?: string }> = [];
const sendAlert = jest.fn(async (opts: { title: string; details: string; appointmentId?: string; dedupGroup?: string }) => {
  const key = `${opts.dedupGroup || opts.title}|${opts.appointmentId}`;
  const expiresAt = slackKeys.get(key);
  if (expiresAt !== undefined && expiresAt > clock) return true; // suppressed
  slackKeys.set(key, clock + DAY_MS);
  delivered.push(opts);
  return true;
});
jest.mock('../services/slack-notification.service', () => ({
  slackNotificationService: {
    sendAlert: (opts: never) => sendAlert(opts),
    // The pre-fix path: same title, one shared 24h group.
    notifyHumanReviewFlagged: (p: { appointmentId: string; therapistName: string; reason: string }) =>
      sendAlert({ title: 'Human Review Requested', details: `AI flagged for review: ${p.reason}`, appointmentId: p.appointmentId, dedupGroup: 'human-control' }),
    notifyCancelMatchRecommended: jest.fn(),
  },
}));

const markers = new Set<string>();
jest.mock('../utils/redis', () => ({
  cacheManager: {
    setNX: jest.fn(async (key: string) => {
      if (markers.has(key)) return 'EXISTS';
      markers.add(key);
      return 'OK';
    }),
  },
  redis: { get: jest.fn(), getStrict: jest.fn(), set: jest.fn(), incr: jest.fn(), expire: jest.fn(), del: jest.fn() },
}));

const row = { id: 'apt-1', humanControlEnabled: false };
const events: string[] = [];
jest.mock('../utils/database', () => ({
  prisma: {
    appointmentRequest: {
      updateMany: jest.fn(async ({ where, data }: { where: { humanControlEnabled?: boolean }; data: { humanControlEnabled?: boolean } }) => {
        if (where.humanControlEnabled !== undefined && row.humanControlEnabled !== where.humanControlEnabled) return { count: 0 };
        if (data.humanControlEnabled !== undefined) {
          row.humanControlEnabled = data.humanControlEnabled;
          events.push('flip');
        }
        return { count: 1 };
      }),
      update: jest.fn(),
      findUnique: jest.fn(),
    },
  },
}));

const settings: Record<string, unknown> = {};
jest.mock('../services/settings.service', () => ({
  getSettingValue: jest.fn(async (key: string) => settings[key]),
}));
jest.mock('../services/audit-event.service', () => ({ auditEventService: { log: jest.fn() } }));
const appendConversationMessage = jest.fn();
jest.mock('../services/ai-conversation.service', () => ({
  aiConversationService: { appendConversationMessage: (...a: unknown[]) => appendConversationMessage(...a) },
}));
const sendAppointmentEmail = jest.fn(async (..._a: unknown[]) => {
  events.push(row.humanControlEnabled ? 'holding-reply-after-flip' : 'holding-reply');
  return { status: 'sent' };
});
jest.mock('../domain/scheduling/agent/send', () => ({
  sendAppointmentEmail: (...a: unknown[]) => sendAppointmentEmail(...a),
}));

import { flagForHumanReview } from '../domain/scheduling/agent/handlers/human-control';
import { HUMAN_REVIEW_ALERT_DEDUP_WINDOW_MS } from '../services/admin-notification.service';
import type { SchedulingContext } from '../services/scheduling-context.service';

const CONTEXT: SchedulingContext = {
  appointmentRequestId: 'apt-1',
  userName: 'Maria',
  userEmail: 'maria@example.com',
  therapistEmail: 'dr.j@example.com',
  therapistName: 'Jones',
  therapistAvailability: null,
  bookingMethod: 'agent_negotiated',
  userCountry: 'UK',
  therapistCountry: 'UK',
  inboundSender: 'user',
  turnId: 'inbound:abc',
};

const release = () => {
  row.humanControlEnabled = false;
};

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(Date, 'now').mockImplementation(() => clock);
  clock = Date.parse('2026-09-28T09:00:00Z');
  slackKeys.clear();
  delivered.length = 0;
  markers.clear();
  events.length = 0;
  row.humanControlEnabled = false;
  for (const k of Object.keys(settings)) delete settings[k];
  settings['agent.fromName'] = 'Justin Time';
});

afterEach(() => jest.restoreAllMocks());

describe('human-review Slack alerts', () => {
  const REASON = 'Tool error circuit breaker tripped (3 failures in one turn). Agent paused for review.';

  it('re-pausing the same appointment for the same reason after a release alerts again', async () => {
    await flagForHumanReview(CONTEXT, { reason: REASON }, 't1');
    release();
    clock += 30 * 60 * 1000; // the admin released it half an hour later; it trips again
    await flagForHumanReview(CONTEXT, { reason: REASON }, 't2');

    expect(delivered).toHaveLength(2);
  });

  it('a different reason alerts immediately', async () => {
    await flagForHumanReview(CONTEXT, { reason: REASON }, 't1');
    release();
    await flagForHumanReview(CONTEXT, { reason: 'Client is asking about something out of scope' }, 't2');
    expect(delivered).toHaveLength(2);
  });

  it('the same reason within the short window is still deduplicated', async () => {
    await flagForHumanReview(CONTEXT, { reason: REASON }, 't1');
    release();
    clock += 60 * 1000;
    expect(60 * 1000).toBeLessThan(HUMAN_REVIEW_ALERT_DEDUP_WINDOW_MS);
    await flagForHumanReview(CONTEXT, { reason: REASON }, 't2');
    expect(delivered).toHaveLength(1);
  });

  it('no alert when human control was already on (admin takeover preserved)', async () => {
    row.humanControlEnabled = true;
    await flagForHumanReview(CONTEXT, { reason: REASON }, 't1');
    expect(delivered).toHaveLength(0);
  });
});

describe('holding reply on escalation', () => {
  beforeEach(() => {
    settings['agent.holdingReplyOnEscalation'] = true;
  });

  it('replies to the client who wrote in, before the pause takes effect, and notes it in the log', async () => {
    await flagForHumanReview(CONTEXT, { reason: 'unsure' }, 't1');

    expect(sendAppointmentEmail).toHaveBeenCalledTimes(1);
    const [email, appointmentId] = sendAppointmentEmail.mock.calls[0] as [{ to: string; body: string }, string];
    expect(email.to).toBe('maria@example.com');
    expect(email.body).toMatch(/Hi Maria/);
    expect(email.body).toMatch(/a colleague, who will pick this up/);
    expect(email.body).toMatch(/Justin$/);
    expect(appointmentId).toBe('apt-1');
    // Sent while human control was still off (the outbound path refuses after).
    expect(events).toEqual(['holding-reply', 'flip']);
    expect(appendConversationMessage).toHaveBeenCalledWith('apt-1', expect.objectContaining({ role: 'admin', content: expect.stringMatching(/holding reply sent to the client/) }));
  });

  it('replies to the therapist when the therapist wrote in', async () => {
    await flagForHumanReview({ ...CONTEXT, inboundSender: 'therapist' }, { reason: 'unsure' }, 't1');
    expect((sendAppointmentEmail.mock.calls[0][0] as { to: string; body: string }).to).toBe('dr.j@example.com');
    expect((sendAppointmentEmail.mock.calls[0][0] as { body: string }).body).toMatch(/Hi Jones/);
  });

  it('is sent at most once per escalation (same turn / redelivered email)', async () => {
    await flagForHumanReview(CONTEXT, { reason: 'Tool execution ceiling reached' }, 't1');
    await flagForHumanReview(CONTEXT, { reason: 'Tool execution ceiling reached' }, 't1');
    release();
    await flagForHumanReview(CONTEXT, { reason: 'unsure' }, 't1'); // same inbound replayed after release
    expect(sendAppointmentEmail).toHaveBeenCalledTimes(1);

    release();
    await flagForHumanReview({ ...CONTEXT, turnId: 'inbound:new-email' }, { reason: 'unsure' }, 't2');
    expect(sendAppointmentEmail).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['an unverified sender', { inboundSender: 'unknown' as const }],
    ['the kickoff turn (no sender)', { inboundSender: undefined }],
  ])('is never sent to %s', async (_label, override) => {
    await flagForHumanReview({ ...CONTEXT, ...override }, { reason: 'unsure' }, 't1');
    expect(sendAppointmentEmail).not.toHaveBeenCalled();
    expect(row.humanControlEnabled).toBe(true); // the escalation itself still happened
  });

  it('is not sent when agent.holdingReplyOnEscalation is off', async () => {
    settings['agent.holdingReplyOnEscalation'] = false;
    await flagForHumanReview(CONTEXT, { reason: 'unsure' }, 't1');
    expect(sendAppointmentEmail).not.toHaveBeenCalled();
    expect(row.humanControlEnabled).toBe(true);
  });

  it('a failing send never blocks the escalation', async () => {
    sendAppointmentEmail.mockRejectedValueOnce(new Error('boom'));
    await flagForHumanReview(CONTEXT, { reason: 'unsure' }, 't1');
    expect(row.humanControlEnabled).toBe(true);
    expect(delivered).toHaveLength(1);
  });
});
