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
      therapistEmail: true,
      userEmail: true,
      updatedAt: true,
      chaseSentAt: true,
      chaseSentTo: true,
      conversationState: true,
      messageCount: true,
      lastToolExecutedAt: true,
      lastToolExecutionFailed: true,
      lastToolFailureReason: true,
    },
  });

  if (appointments.length === 0) {
    console.log('  (no rows found)');
  } else {
    for (const a of appointments) {
      // Print everything except the conversationState blob (separately, summarised).
      const { conversationState, ...rest } = a;
      console.log(JSON.stringify(rest, null, 2));

      // Conversation state structural summary (so we don't dump 100KB).
      console.log('\n--- 1a. conversation_state structural summary ---');
      if (!conversationState) {
        console.log('  (null)');
      } else {
        const raw = conversationState as unknown;
        let parsed: any;
        if (typeof raw === 'string') {
          try { parsed = JSON.parse(raw); } catch { parsed = null; }
        } else {
          parsed = raw;
        }
        if (!parsed) {
          console.log('  (unparseable)');
        } else {
          const jsonStr = typeof raw === 'string' ? raw : JSON.stringify(raw);
          console.log(`  total JSON bytes: ${jsonStr.length}`);
          console.log(`  has 'messages': ${Array.isArray(parsed.messages)} (len ${parsed.messages?.length ?? 0})`);
          console.log(`  has 'checkpoint': ${parsed.checkpoint !== undefined}`);
          if (parsed.checkpoint) {
            console.log(`    checkpoint.stage: ${parsed.checkpoint.stage ?? '(missing)'}`);
            console.log(`    checkpoint.lastSuccessfulAction: ${parsed.checkpoint.lastSuccessfulAction ?? '(missing)'}`);
            console.log(`    checkpoint.pendingAction: ${parsed.checkpoint.pendingAction ?? '(missing)'}`);
            console.log(`    checkpoint.context: ${JSON.stringify(parsed.checkpoint.context ?? {})}`);
          }
          console.log(`  has 'facts': ${parsed.facts !== undefined}`);
          console.log(`  has 'responseTracking': ${parsed.responseTracking !== undefined}`);
          console.log(`  has 'systemPrompt': ${typeof parsed.systemPrompt === 'string' ? parsed.systemPrompt.length + ' bytes' : 'no'}`);
          if (Array.isArray(parsed.messages)) {
            console.log(`\n  Last 5 messages (role / first 100 chars of content):`);
            for (const m of parsed.messages.slice(-5)) {
              const content = typeof m.content === 'string' ? m.content.slice(0, 100).replace(/\s+/g, ' ') : '[non-string]';
              console.log(`    [${m.role ?? '?'}]  ${content}`);
            }
          }
        }
      }
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
      `\n--- 3. Last 50 audit events for appointment ${appointmentId} ---`,
    );
    const events = await prisma.appointmentAuditEvent.findMany({
      where: { appointmentRequestId: appointmentId },
      orderBy: { createdAt: 'desc' },
      take: 50,
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

    // Event-type histogram so we can see at a glance whether the agent
    // is actually executing tools or just observing messages.
    console.log(`\n--- 3a. Audit-event-type histogram (last 50) ---`);
    const hist = new Map<string, number>();
    for (const e of events) {
      hist.set(e.eventType, (hist.get(e.eventType) ?? 0) + 1);
    }
    for (const [t, n] of [...hist.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(n).padStart(3)}  ${t}`);
    }

    // 3b. Cross-check: any processed_gmail_messages with IDs matching
    //     messageIds that appear in the audit_events payload?
    console.log(`\n--- 3b. processed_gmail_messages mentioned in audit payloads ---`);
    const messageIdSet = new Set<string>();
    for (const e of events) {
      const p = e.payload as Record<string, unknown> | null;
      if (p && typeof p.gmailMessageId === 'string') messageIdSet.add(p.gmailMessageId);
    }
    if (messageIdSet.size === 0) {
      console.log('  (no gmailMessageId in any audit payload — payloads may not include it)');
    } else {
      const processed = await prisma.processedGmailMessage.findMany({
        where: { id: { in: [...messageIdSet] } },
        select: { id: true, context: true, processedAt: true },
      });
      console.log(`  Messages mentioned in audit: ${messageIdSet.size}, of which marked processed: ${processed.length}`);
      for (const p of processed) {
        console.log(`    ${p.id}  context=${p.context}  at=${p.processedAt.toISOString()}`);
      }
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
