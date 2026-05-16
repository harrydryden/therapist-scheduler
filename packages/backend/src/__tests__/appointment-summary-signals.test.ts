/**
 * Regression tests for `buildAppointmentSummary`'s extraction of
 * `lastEmailSentTo` and the normalised `lastMessageRole` from
 * conversation state — both of which are fed to `deriveNextAction`
 * to produce specific "Awaiting reply from user/therapist" copy
 * on the detail panel.
 *
 * Why this matters: the dashboard list endpoint also extracts these
 * signals (via SQL JSONB path expressions) and feeds the same
 * deriveNextAction. The two views MUST agree about what to show.
 * Before this regression test, the detail summary builder didn't
 * pass either signal and silently fell through to the generic
 * "Awaiting initial outreach" wording — drift between dashboard
 * row and detail panel for the same appointment.
 */

jest.mock('../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { buildAppointmentSummary } from '../utils/appointment-summary';

function baseAppointment(overrides: Record<string, unknown> = {}) {
  return {
    status: 'negotiating',
    humanControlEnabled: false,
    humanControlTakenBy: null,
    isStale: false,
    lastActivityAt: new Date('2026-06-01T10:00:00Z'),
    chaseSentAt: null,
    chaseSentTo: null,
    closureRecommendedAt: null,
    closureRecommendedReason: null,
    closureRecommendationActioned: false,
    confirmedDateTime: null,
    messageCount: 5,
    ...overrides,
  };
}

describe('buildAppointmentSummary — lastEmailSentTo / lastMessageRole pass-through', () => {
  it("surfaces 'Awaiting reply from user' when checkpoint.context.lastEmailSentTo = 'user'", () => {
    // Checkpoint stage absent (the admin-created cohort). Without
    // the pass-through, this used to render "Awaiting initial
    // outreach".
    const result = buildAppointmentSummary(
      {
        messages: [{ role: 'assistant', content: 'Email sent to user' }],
        checkpoint: { context: { lastEmailSentTo: 'user' } },
      },
      baseAppointment(),
    );
    expect(result.nextAction).toBe('Awaiting reply from user');
  });

  it("surfaces 'Awaiting reply from therapist' when checkpoint.context.lastEmailSentTo = 'therapist'", () => {
    const result = buildAppointmentSummary(
      {
        messages: [{ role: 'assistant', content: 'Email sent to therapist' }],
        checkpoint: { context: { lastEmailSentTo: 'therapist' } },
      },
      baseAppointment(),
    );
    expect(result.nextAction).toBe('Awaiting reply from therapist');
  });

  it("falls back to 'Awaiting reply' when only the message role is known", () => {
    // Older rows pre-date the lastEmailSentTo capture. The
    // normalised last-message-role still produces an informative
    // (if less specific) action.
    const result = buildAppointmentSummary(
      {
        messages: [{ role: 'assistant', content: 'Some agent output' }],
      },
      baseAppointment(),
    );
    expect(result.nextAction).toBe('Awaiting reply');
  });

  it("uses 'Agent processing inbound message' when last role is a user reply", () => {
    const result = buildAppointmentSummary(
      {
        messages: [{ role: 'user', content: 'Reply from client' }],
      },
      baseAppointment(),
    );
    expect(result.nextAction).toBe('Agent processing inbound message');
  });

  it('uses the stage-derived action when a checkpoint stage exists', () => {
    // Stage wins over the fallback signals — pre-existing behaviour
    // we don't want to break.
    const result = buildAppointmentSummary(
      {
        messages: [{ role: 'assistant', content: 'whatever' }],
        checkpoint: {
          stage: 'awaiting_therapist_availability',
          context: { lastEmailSentTo: 'user' /* intentionally mismatched */ },
        },
      },
      baseAppointment(),
    );
    expect(result.nextAction).toBe('Awaiting reply from therapist on availability request');
  });

  it('handles a malformed checkpoint.context gracefully', () => {
    // Defensive: a non-object context shouldn't throw — fallback to
    // null and proceed.
    const result = buildAppointmentSummary(
      {
        messages: [{ role: 'assistant' }],
        checkpoint: { context: 'not-an-object' },
      },
      baseAppointment(),
    );
    expect(result.nextAction).toBe('Awaiting reply');
  });

  it('falls back to initial outreach with no messages at all', () => {
    const result = buildAppointmentSummary({ messages: [] }, baseAppointment());
    expect(result.nextAction).toBe('Awaiting initial outreach');
  });

  it('normalises raw role: "admin" → admin (treated like agent for next-action)', () => {
    // The 'admin' role lands in conversation state when an admin
    // sends a manual message. With no checkpoint stage, that's
    // neither "agent sent" nor "inbound arrived" — the role-based
    // inference currently treats it as no signal, falling through
    // to "Awaiting initial outreach". Pin that behaviour so a
    // future change is intentional.
    const result = buildAppointmentSummary(
      {
        messages: [{ role: 'admin', content: '[System] note' }],
      },
      baseAppointment(),
    );
    expect(result.nextAction).toBe('Awaiting initial outreach');
  });
});
