/**
 * Tests for the `purpose` field on send_email — the structured intent
 * declaration that lets the system distinguish e.g. a courtesy ack to
 * the therapist from a "please send more slots" follow-up, both of
 * which look identical from the recipient alone.
 *
 * Without this field, the system had to infer stage progression from
 * the email recipient. That worked for the happy path but broke the
 * minute the agent legitimately needed to go BACKWARDS in the FSM
 * (the user-rejection case fixed in PR #269). The `wouldRegress` guard
 * was added to block accidental regressions from courtesy emails but
 * also blocked intentional regressions — there was no way to tell the
 * difference. Explicit purpose closes that gap.
 *
 * Layers pinned here:
 *   - Handler: purpose → checkpointAction mapping (one test per enum
 *     value, plus the fallback paths for `other` and omitted).
 *   - Handler: purpose echoed back on the result so the agent loop can
 *     exempt intentional regressions from wouldRegress.
 */

jest.mock('../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockSendAppointmentEmail = jest.fn().mockResolvedValue(undefined);
jest.mock('../core/agent/tools/send', () => ({
  sendAppointmentEmail: (...args: unknown[]) => mockSendAppointmentEmail(...args),
}));

import { handleSendEmail } from '../core/agent/tools/handlers/send-email';
import type { SchedulingContext } from '../services/scheduling-context.service';

const CONTEXT: SchedulingContext = {
  appointmentRequestId: 'apt-test',
  userName: 'Maria',
  userEmail: 'maria@example.com',
  therapistEmail: 'ashleigh@example.com',
  therapistName: 'Ashleigh',
  therapistAvailability: null,
  bookingMethod: 'agent_negotiated',
  userCountry: 'UK',
  therapistCountry: 'UK',
} as SchedulingContext;

function call(input: {
  to: string;
  subject?: string;
  body?: string;
  purpose?: string;
}) {
  return handleSendEmail(
    {
      to: input.to,
      subject: input.subject ?? 'Spill — test',
      body: input.body ?? 'Test body',
      purpose: input.purpose,
    },
    CONTEXT,
    'trace-test',
  );
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('send_email — purpose-driven checkpointAction', () => {
  it('purpose=request_availability → sent_initial_email_to_therapist', async () => {
    const outcome = await call({ to: 'ashleigh@example.com', purpose: 'request_availability' });
    expect(outcome.checkpointAction).toBe('sent_initial_email_to_therapist');
    expect(outcome.emailSentTo).toBe('therapist');
    expect(outcome.purpose).toBe('request_availability');
  });

  it('purpose=send_options → sent_availability_to_user', async () => {
    const outcome = await call({ to: 'maria@example.com', purpose: 'send_options' });
    expect(outcome.checkpointAction).toBe('sent_availability_to_user');
    expect(outcome.emailSentTo).toBe('user');
    expect(outcome.purpose).toBe('send_options');
  });

  it('purpose=confirm_slot_with_therapist → sent_confirmation_request_to_therapist', async () => {
    const outcome = await call({
      to: 'ashleigh@example.com',
      purpose: 'confirm_slot_with_therapist',
    });
    expect(outcome.checkpointAction).toBe('sent_confirmation_request_to_therapist');
    expect(outcome.purpose).toBe('confirm_slot_with_therapist');
  });

  it('purpose=request_more_availability → received_user_slot_rejection (wires PR #269 action)', async () => {
    // This is the case the architecture audit and the Maria/Ashleigh
    // Slack example were both about. Without the explicit purpose field,
    // a send_email to the therapist from `awaiting_user_slot_selection`
    // produced action `sent_initial_email_to_therapist` (recipient-based)
    // and got blocked by wouldRegress. Now the agent declares intent
    // and the system records the correct action.
    const outcome = await call({
      to: 'ashleigh@example.com',
      purpose: 'request_more_availability',
    });
    expect(outcome.checkpointAction).toBe('received_user_slot_rejection');
    expect(outcome.purpose).toBe('request_more_availability');
  });

  it('purpose=acknowledge → no checkpointAction (stage MUST NOT change)', async () => {
    // Courtesy reply ("thanks", "I'll get back to you"). The party we're
    // waiting on hasn't changed, so the stage must remain where it is.
    // checkpointAction === undefined tells the loop to skip the update
    // entirely — without this, the recipient-based fallback would
    // wrongly advance/regress the stage just for sending a courtesy.
    const outcome = await call({ to: 'maria@example.com', purpose: 'acknowledge' });
    expect(outcome.checkpointAction).toBeUndefined();
    expect(outcome.purpose).toBe('acknowledge');
    // emailSentTo still flows through for chase-routing context.
    expect(outcome.emailSentTo).toBe('user');
  });

  it('purpose=other → falls back to recipient-based action (catch-all)', async () => {
    const toTherapist = await call({ to: 'ashleigh@example.com', purpose: 'other' });
    expect(toTherapist.checkpointAction).toBe('sent_initial_email_to_therapist');

    const toUser = await call({ to: 'maria@example.com', purpose: 'other' });
    expect(toUser.checkpointAction).toBe('sent_availability_to_user');
  });

  it('purpose omitted → falls back to recipient-based action (legacy compat)', async () => {
    // Critical: existing agent calls that don't yet pass purpose must
    // still produce the same checkpointAction they did before this PR,
    // so in-flight conversations aren't disrupted by the new field.
    const toTherapist = await call({ to: 'ashleigh@example.com' });
    expect(toTherapist.checkpointAction).toBe('sent_initial_email_to_therapist');
    expect(toTherapist.purpose).toBeUndefined();

    const toUser = await call({ to: 'maria@example.com' });
    expect(toUser.checkpointAction).toBe('sent_availability_to_user');
    expect(toUser.purpose).toBeUndefined();
  });

  it('rejects an unrecognised purpose value at the schema layer', async () => {
    const outcome = await call({ to: 'maria@example.com', purpose: 'not_a_real_purpose' });
    expect(outcome.result.success).toBe(false);
    expect(outcome.result.error).toMatch(/Invalid send_email input/);
    // The send is NOT executed when validation fails.
    expect(mockSendAppointmentEmail).not.toHaveBeenCalled();
  });
});
