/**
 * Tests for the `slot_rejection` intent + the `received_user_slot_rejection`
 * checkpoint action + the new `awaiting_user_slot_selection ->
 * awaiting_therapist_availability` FSM transition.
 *
 * Closes the documented bug where the agent, faced with a user rejecting
 * all offered times, sent a polite acknowledgement ("I'll check in with
 * X") but didn't actually call send_email to the therapist — leaving
 * the conversation stuck at `awaiting_user_slot_selection` while we
 * were really waiting on the therapist. The chase service would then
 * route the next chase to the user (the wrong party) after 72h.
 *
 * Multiple layers were affected; this file pins each layer's contract:
 *   - Classifier: rejection phrases route to `slot_rejection` (so the
 *     formatted classification prompt block surfaces this signal to
 *     Claude alongside the workflow prose).
 *   - FSM: the new action maps to the correct stage; the transition
 *     from awaiting_user_slot_selection back to
 *     awaiting_therapist_availability is now legal.
 */

jest.mock('../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { classifyEmail } from '../services/email-classifier.service';
import {
  stageFromAction,
  isValidTransition,
} from '../services/conversation-checkpoint.service';

const USER_EMAIL = 'user@example.com';
const THERAPIST_EMAIL = 'therapist@example.com';

describe('classifier — slot_rejection intent', () => {
  it.each([
    "Hi Justin,\nI'm afraid none of those times work.\nLet me know if you get new ones.\nMaria",
    "None of these slots suit me — could you suggest other times?",
    "I'm not free on either of those days.",
    "Those times don't work, sorry.",
    "Can you propose some other times?",
    "Please send me more options, those don't fit my schedule.",
    "Sorry, none of them work for me. Let me know if you have new ones.",
  ])('classifies %p as slot_rejection', (body) => {
    const result = classifyEmail(body, USER_EMAIL, USER_EMAIL, THERAPIST_EMAIL);
    expect(result.intent).toBe('slot_rejection');
  });

  it('does NOT classify a positive slot selection as rejection', () => {
    const result = classifyEmail(
      "Tuesday at 6pm works for me!",
      USER_EMAIL,
      USER_EMAIL,
      THERAPIST_EMAIL,
    );
    expect(result.intent).toBe('slot_selection');
  });

  it('does NOT classify a reschedule request as rejection', () => {
    const result = classifyEmail(
      "Something came up — can we reschedule our appointment?",
      USER_EMAIL,
      USER_EMAIL,
      THERAPIST_EMAIL,
    );
    expect(result.intent).toBe('reschedule_request');
  });

  it('does NOT classify a cancellation as rejection', () => {
    const result = classifyEmail(
      "Please cancel my booking — I no longer need it.",
      USER_EMAIL,
      USER_EMAIL,
      THERAPIST_EMAIL,
    );
    expect(result.intent).toBe('cancellation');
  });
});

describe('FSM — received_user_slot_rejection', () => {
  it('maps to awaiting_therapist_availability', () => {
    expect(stageFromAction('received_user_slot_rejection')).toBe(
      'awaiting_therapist_availability',
    );
  });

  it('the new transition awaiting_user_slot_selection -> awaiting_therapist_availability is now legal', () => {
    // Before this fix, the only legal forward transitions from
    // awaiting_user_slot_selection went to awaiting_therapist_confirmation,
    // cancelled, stalled, rescheduling, chased, or closure_recommended.
    // The "user rejected, ask therapist again" case had no legal path —
    // updateCheckpoint would log an "unexpected transition" warning and
    // the chase service would route to the wrong party.
    expect(
      isValidTransition('awaiting_user_slot_selection', 'awaiting_therapist_availability'),
    ).toBe(true);
  });

  it('does not silently allow other regressions from awaiting_user_slot_selection', () => {
    // awaiting_therapist_availability is the ONLY new regression we want.
    // Going back to initial_contact from awaiting_user_slot_selection is
    // still not a sanctioned transition.
    expect(
      isValidTransition('awaiting_user_slot_selection', 'initial_contact'),
    ).toBe(false);
  });
});
