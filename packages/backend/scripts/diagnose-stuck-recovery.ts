/**
 * One-shot diagnostic for the "Scan finds MISSED message but Recover
 * doesn't fix it" symptom. Reads the three pieces of state that
 * determine whether recovery can succeed:
 *
 *   1. The appointment's current human-control state. If
 *      `human_control_enabled = true` (especially with
 *      `human_control_taken_by = 'system-auto-escalation'`), the
 *      Recover-button code path's `processEmailReply` short-circuits
 *      via `loggedWhilePaused` and silently skips marking the
 *      message processed.
 *
 *   2. Any `TherapistConversation` row matching the same Gmail
 *      thread. If one exists, `findMatchingTherapistConversation`
 *      shadows the appointment match and routes the inbound to the
 *      availability-collection agent instead of the booking agent.
 *
 *   3. The full recent audit-event history for the appointment, so
 *      we can see exactly when human control was taken/released and
 *      by whom (admin vs. system-auto-escalation).
 *
 * Usage (from packages/backend):
 *   railway run npx tsx scripts/diagnose-stuck-recovery.ts <therapistGmailThreadId>
 *
 * Example:
 *   railway run npx tsx scripts/diagnose-stuck-recovery.ts 19e0c1dc16d656b1
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main(): Promise<void> {
  const threadId = process.argv[2];
  if (!threadId) {
    console.error('Usage: tsx scripts/diagnose-stuck-recovery.ts <therapistGmailThreadId>');
    process.exit(1);
  }

  await prisma.$connect();

  console.log(`\n=== Diagnostic for therapist_gmail_thread_id = ${threadId} ===\n`);

  // 1. Appointment + human-control state.
  console.log('--- 1. Appointment row(s) on this thread ---');
  const appointments = await prisma.appointmentRequest.findMany({
    where: { therapistGmailThreadId: threadId },
    select: {
      id: true,
      status: true,
      humanControlEnabled: true,
      humanControlTakenBy: true,
      humanControlTakenAt: true,
      autoEscalatedAt: true,
      lastActivityAt: true,
      conversationStallAlertAt: true,
      userName: true,
      therapistName: true,
      checkpointStage: true,
      gmailThreadId: true,
    },
  });

  if (appointments.length === 0) {
    console.log('  (no rows found)');
  } else {
    for (const a of appointments) {
      console.log(JSON.stringify(a, null, 2));
    }
  }

  // 2. Therapist conversations on the same thread (would shadow the
  //    appointment match).
  console.log('\n--- 2. TherapistConversation row(s) on the same thread ---');
  const convos = await prisma.therapistConversation.findMany({
    where: { gmailThreadId: threadId },
    select: {
      id: true,
      kind: true,
      status: true,
      supersededAckSent: true,
      gmailThreadId: true,
      lastActivityAt: true,
      therapistId: true,
    },
  });

  if (convos.length === 0) {
    console.log('  (none — appointment-routing is clean of TherapistConversation shadowing)');
  } else {
    console.log(
      `  FOUND ${convos.length} row(s) — this would shadow appointment-routing via findMatchingTherapistConversation:`,
    );
    for (const c of convos) {
      console.log(JSON.stringify(c, null, 2));
    }
  }

  // 3. Recent human-control + email audit events for the appointment.
  //    Want to see EXACTLY when control was taken/released and by whom.
  if (appointments.length > 0) {
    const appointmentId = appointments[0].id;
    console.log(
      `\n--- 3. Last 20 audit events for appointment ${appointmentId} ---`,
    );
    const events = await prisma.appointmentAuditEvent.findMany({
      where: { appointmentRequestId: appointmentId },
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: {
        createdAt: true,
        eventType: true,
        actor: true,
        payload: true,
      },
    });
    for (const e of events) {
      const payloadStr =
        e.payload && typeof e.payload === 'object'
          ? JSON.stringify(e.payload).slice(0, 200)
          : String(e.payload);
      console.log(
        `  ${e.createdAt.toISOString()}  ${e.eventType.padEnd(20)}  ${e.actor.padEnd(25)}  ${payloadStr}`,
      );
    }

    // 4. Any processed-gmail-messages on this thread (to confirm what
    //    HAS been marked vs what's outstanding).
    console.log(
      `\n--- 4. Processed Gmail messages for this appointment's threads ---`,
    );
    // Can't easily filter ProcessedGmailMessage by thread without
    // re-querying Gmail. We can at least show ALL the entries that
    // mention this thread's ids by hopping through messageProcessingFailure
    // and unmatchedEmailAttempt for context.
    const failures = await prisma.messageProcessingFailure.findMany({
      orderBy: { lastFailedAt: 'desc' },
      take: 10,
      select: {
        id: true,
        attempts: true,
        firstFailedAt: true,
        lastFailedAt: true,
        lastError: true,
        abandoned: true,
      },
    });
    console.log(`  Recent message_processing_failures (top 10, all threads):`);
    for (const f of failures) {
      console.log(
        `    ${f.id}  attempts=${f.attempts}  abandoned=${f.abandoned}  lastError=${(f.lastError || '').slice(0, 100)}`,
      );
    }
  }
}

main()
  .catch((err) => {
    console.error('Diagnostic failed:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
