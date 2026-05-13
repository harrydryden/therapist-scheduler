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
import { sendEmailInputSchema } from '../../../../schemas/tool-inputs';
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

  // Set checkpoint action based on recipient so the conversation
  // stage is properly tracked. Without this, the checkpoint is never
  // initialized after startScheduling (only send_email is called),
  // leaving the stage as undefined and breaking stage-aware recovery
  // and prompt guidance.
  const checkpointAction: ConversationAction =
    emailSentTo === 'therapist'
      ? 'sent_initial_email_to_therapist'
      : 'sent_availability_to_user';

  return {
    result: { success: true, toolName: 'send_email' },
    checkpointAction,
    emailSentTo,
  };
}
