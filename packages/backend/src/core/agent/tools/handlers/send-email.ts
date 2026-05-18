/**
 * `send_email` — agent-initiated outbound email to the user or
 * therapist.
 *
 * Security: validates that the recipient address is one of the two
 * known parties for this appointment. The agent has no path to
 * send to an arbitrary address even if it tries.
 *
 * Side effects: routes through `sendAppointmentEmail` which handles
 * Spill-prefix, body normalization, atomic human-control re-check,
 * tracking-code embedding, thread-ID lookup/storage, and the queue
 * fallback.
 */

import { logger } from '../../../../utils/logger';
import {
  sendEmailInputSchema,
  type SendEmailPurpose,
} from '../../../../schemas/tool-inputs';
import { sendAppointmentEmail } from '../send';
import type { ConversationAction } from '../../../../services/conversation-checkpoint.service';
import type {
  SchedulingContext,
  ToolExecutionResult,
} from '../../../../services/scheduling-context.service';

export interface SendEmailHandlerOutcome {
  result: ToolExecutionResult;
  checkpointAction?: ConversationAction;
  emailSentTo?: 'user' | 'therapist';
  /**
   * Echoes back the declared purpose (if any) so the agent loop can
   * use it for downstream decisions — specifically, exempting
   * intentional regressions (e.g. `request_more_availability`) from
   * the `wouldRegress` guard, and treating `acknowledge` as a no-op
   * for stage tracking. Distinct from `checkpointAction` because some
   * purposes (`acknowledge`) deliberately don't emit one.
   */
  purpose?: SendEmailPurpose;
}

/**
 * Map a declared purpose to a checkpoint action. Returns null for
 * 'acknowledge' (no stage change) and 'other' (caller falls back to
 * recipient-based mapping).
 *
 * Defined as a switch rather than a Record so TS exhaustiveness-checks
 * the SendEmailPurpose union — adding a new purpose without updating
 * this mapping fails the build.
 */
function actionForPurpose(
  purpose: SendEmailPurpose,
): ConversationAction | null {
  switch (purpose) {
    case 'request_availability':
      return 'sent_initial_email_to_therapist';
    case 'send_options':
      return 'sent_availability_to_user';
    case 'confirm_slot_with_therapist':
      return 'sent_confirmation_request_to_therapist';
    case 'request_more_availability':
      // PR #269 introduced this action but no code path emitted it
      // until now. The declared-purpose tool input is the path.
      return 'received_user_slot_rejection';
    case 'acknowledge':
      // Courtesy reply — stage MUST NOT change. Returning null tells
      // the loop to skip the checkpoint update entirely. This is the
      // structurally-correct way to send "thanks, I'll get back to
      // you" without flipping the stage (and triggering the chain of
      // chase / dashboard / FSM consequences that follow a flip).
      return null;
    case 'other':
      // Caller falls back to recipient-based mapping below.
      return null;
  }
}

export async function handleSendEmail(
  rawInput: unknown,
  context: SchedulingContext,
  traceId: string,
): Promise<SendEmailHandlerOutcome> {
  const parsed = sendEmailInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const errorMsg = `Invalid send_email input: ${parsed.error.message}`;
    logger.error({ traceId, errors: parsed.error.errors }, 'Invalid send_email input');
    return { result: { success: false, toolName: 'send_email', error: errorMsg } };
  }
  const emailData = parsed.data;

  // SECURITY: validate that the recipient is either the user or
  // therapist. Prevents the agent from hallucinating email addresses
  // or sending to arbitrary recipients.
  const normalizedTo = emailData.to.toLowerCase().trim();
  const allowedRecipients = [
    context.userEmail.toLowerCase().trim(),
    context.therapistEmail.toLowerCase().trim(),
  ].filter((e) => e);

  if (!allowedRecipients.includes(normalizedTo)) {
    const errorMsg =
      `Invalid recipient: "${emailData.to}" is not a recognized email for this appointment. ` +
      `Allowed recipients are: ${context.userEmail} (client) or ${context.therapistEmail} (therapist). ` +
      `Please use the exact email address provided in the context.`;
    logger.error(
      {
        traceId,
        attemptedRecipient: emailData.to,
        allowedRecipients,
        appointmentRequestId: context.appointmentRequestId,
      },
      'Agent attempted to send email to unauthorized recipient',
    );
    return { result: { success: false, toolName: 'send_email', error: errorMsg } };
  }

  await sendAppointmentEmail(
    { to: emailData.to, subject: emailData.subject, body: emailData.body },
    context.appointmentRequestId,
    traceId,
  );

  const emailSentTo: 'user' | 'therapist' =
    normalizedTo === context.therapistEmail.toLowerCase() ? 'therapist' : 'user';

  // Resolve checkpoint action. New behaviour (PR-purpose): when the
  // agent declares a `purpose`, use it to derive the action — letting
  // the system distinguish e.g. a courtesy ack to the therapist from
  // a "please send more slots" follow-up, both of which look
  // identical from the recipient alone.
  //
  // Legacy behaviour (purpose omitted, or purpose === 'other'): fall
  // back to recipient-based mapping. In-flight conversations still
  // work; new prompts pass purpose explicitly.
  //
  // Two callsites set `checkpointAction = undefined`:
  //  - purpose === 'acknowledge': stage MUST NOT change (courtesy
  //    reply; we're still waiting on the same party). Returning
  //    undefined from this handler tells the agent loop to skip the
  //    checkpoint update entirely.
  //  - purpose === 'other' with no recipient fallback to apply: same.
  let checkpointAction: ConversationAction | undefined;
  if (emailData.purpose) {
    const fromPurpose = actionForPurpose(emailData.purpose);
    if (fromPurpose !== null) {
      checkpointAction = fromPurpose;
    } else if (emailData.purpose === 'other') {
      // 'other' is the catch-all → fall through to recipient-based.
      checkpointAction =
        emailSentTo === 'therapist'
          ? 'sent_initial_email_to_therapist'
          : 'sent_availability_to_user';
    }
    // 'acknowledge' → checkpointAction stays undefined → no stage change.
  } else {
    // Legacy path: no purpose declared. Same as the previous behaviour
    // (recipient-based mapping). Without this, the checkpoint is never
    // initialized after startScheduling, leaving the stage undefined
    // and breaking stage-aware recovery and prompt guidance.
    checkpointAction =
      emailSentTo === 'therapist'
        ? 'sent_initial_email_to_therapist'
        : 'sent_availability_to_user';
  }

  return {
    result: { success: true, toolName: 'send_email' },
    checkpointAction,
    emailSentTo,
    purpose: emailData.purpose,
  };
}
