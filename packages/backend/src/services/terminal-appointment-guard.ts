/**
 * Terminal-appointment inbound guard for the booking agent.
 *
 * When an inbound email matches an appointment that is already CANCELLED or
 * COMPLETED, the booking agent must NOT auto-respond: the lifecycle FSM is
 * terminal (the agent can't legally transition the row), and an automated
 * reply on a closed booking is rarely the right move. Instead we alert an
 * admin so a human can decide whether action is needed — e.g. a client
 * replying "wait, I didn't mean to cancel" needs a person, not a bot.
 *
 * Why a Slack alert rather than flipping `humanControlEnabled` (the usual
 * "flag for human review" mechanism): the cancellation transition
 * deliberately CLEARS human control (CLEAR_HUMAN_CONTROL_STATE) so cancelled
 * rows don't clutter the Human Control dashboard tile. Re-enabling it on
 * every post-cancellation email would undo that and re-populate the tile with
 * closed bookings. The alert satisfies the intent (a human is notified and
 * can take control manually) without that side effect.
 *
 * Kept in its own module so it's unit-testable without dragging in the
 * orchestrator's anthropic + prisma graph (same rationale as
 * post-reply-status.ts / agent-turn-guard.ts).
 */

import { logger } from '../utils/logger';
import { runBackgroundTask } from '../utils/background-task';
import { slackNotificationService } from './slack-notification.service';

/**
 * Appointment statuses on which the booking agent must not auto-respond.
 * Both are terminal in the lifecycle FSM.
 */
export const TERMINAL_AGENT_STATUSES: readonly string[] = ['cancelled', 'completed'];

export function isTerminalAppointmentStatus(status: string): boolean {
  return TERMINAL_AGENT_STATUSES.includes(status);
}

/**
 * Fire-and-forget admin alert that an inbound landed on a terminal
 * appointment and the agent was skipped. Never throws into the caller —
 * runBackgroundTask isolates the Slack failure path.
 */
export function alertTerminalAppointmentInbound(args: {
  appointmentRequestId: string;
  status: string;
  therapistName: string;
  sender: 'client' | 'therapist';
  traceId: string;
}): void {
  logger.info(
    { traceId: args.traceId, appointmentRequestId: args.appointmentRequestId, status: args.status, sender: args.sender },
    'Inbound on terminal appointment — skipping agent, alerting admin for review',
  );
  runBackgroundTask(
    () =>
      slackNotificationService.sendAlert({
        title: 'Email received on a closed appointment',
        severity: 'medium',
        appointmentId: args.appointmentRequestId,
        therapistName: args.therapistName,
        // PII discipline: sender label (client|therapist) + status is enough
        // to triage; the email itself is in the audit log + Gmail thread.
        details:
          `A ${args.sender} email arrived on a ${args.status} appointment. ` +
          `The agent was skipped — review whether manual action is needed ` +
          `(e.g. reopening the match or redirecting the sender).`,
        additionalFields: { Sender: args.sender, Status: args.status },
      }),
    {
      name: 'terminal-appointment-inbound-alert',
      context: { appointmentRequestId: args.appointmentRequestId, status: args.status },
    },
  );
}
