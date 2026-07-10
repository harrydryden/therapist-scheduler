/**
 * One-off recovery: re-request feedback for a single appointment.
 *
 * Discards the appointment's existing feedback submission (if any) and sends a
 * fresh, properly-tokened feedback-form email — the recovery path for a form
 * that was sent too early or submitted in error. Shares the exact behaviour of
 * the admin "Re-request feedback" endpoint (both call `reRequestFeedback`).
 *
 * Defaults to DRY-RUN. Pass --apply to actually delete the submission, walk the
 * status back if needed, and send the email.
 *
 * Examples:
 *   tsx src/scripts/rerequest-feedback.ts --tracking SPL-1370-0896-1
 *   tsx src/scripts/rerequest-feedback.ts --tracking SPL-1370-0896-1 --apply
 *   tsx src/scripts/rerequest-feedback.ts --id <appointment-uuid> --apply
 */

import { prisma } from '../utils/database';
import { logger } from '../utils/logger';
import { reRequestFeedback } from '../services/feedback-rerequest.service';

interface Args {
  trackingCode?: string;
  id?: string;
  apply: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { apply: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') args.apply = true;
    else if (a === '--tracking') args.trackingCode = argv[++i];
    else if (a === '--id') args.id = argv[++i];
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (!args.trackingCode && !args.id) {
    console.error(
      'Usage: tsx src/scripts/rerequest-feedback.ts (--tracking <CODE> | --id <uuid>) [--apply]',
    );
    process.exit(2);
  }

  const appointment = await prisma.appointmentRequest.findUnique({
    where: args.id ? { id: args.id } : { trackingCode: args.trackingCode!.toUpperCase() },
    select: {
      id: true,
      status: true,
      userEmail: true,
      trackingCode: true,
      feedbackFormSentAt: true,
    },
  });

  if (!appointment) {
    console.error(
      `No appointment found for ${args.id ? `id ${args.id}` : `tracking code ${args.trackingCode}`}`,
    );
    process.exit(1);
  }

  const submissionCount = await prisma.feedbackSubmission.count({
    where: { appointmentRequestId: appointment.id },
  });

  console.log('Appointment:', {
    id: appointment.id,
    trackingCode: appointment.trackingCode,
    status: appointment.status,
    userEmail: appointment.userEmail,
    feedbackFormSentAt: appointment.feedbackFormSentAt,
    existingSubmissions: submissionCount,
  });

  if (!args.apply) {
    console.log(
      `\n[DRY RUN] Would discard ${submissionCount} submission(s), reset feedback state, ` +
        `and send a fresh tokened feedback email to ${appointment.userEmail}.\n` +
        'Re-run with --apply to perform these actions.',
    );
    return;
  }

  const result = await reRequestFeedback({
    appointmentId: appointment.id,
    adminId: 'script:rerequest-feedback',
  });

  console.log('\nDone:', result);

  // Give fire-and-forget transition side effects (SSE, audit follow-ups) a
  // moment to flush before the process tears down the Prisma connection.
  await new Promise((resolve) => setTimeout(resolve, 2000));
}

main()
  .catch((err) => {
    logger.error({ err }, 'rerequest-feedback script failed');
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
