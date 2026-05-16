/**
 * Data remediation for the Amy/Emma stuck-recovery case (and any other
 * appointment exhibiting the same pattern after the code fix lands).
 *
 * What it does (per appointment):
 *   1. Removes duplicate `[Received while paused] ...` entries from
 *      `conversation_state.messages`. Keeps the FIRST occurrence of
 *      each unique pause-log entry, drops subsequent identical copies.
 *      These accumulated across multiple pause/release/re-pause cycles
 *      while the naked-save bug was still in flight.
 *   2. Clears the stale `humanControlTakenBy = 'agent-flagged'` /
 *      `humanControlTakenAt` residue when `humanControlEnabled` is
 *      currently false. The audit_events row remains as the historical
 *      record; the appointment-row columns are just dashboard-display
 *      fields that confuse admins when they hint at a pause that isn't
 *      active.
 *   3. Force-clears any `processedGmailMessage` row for the missed
 *      Gmail message IDs supplied (no-op if the row doesn't exist),
 *      so the next reprocess-thread call actually re-runs the agent.
 *
 * What it does NOT do:
 *   - Doesn't touch `humanControlEnabled` (we never silently re-pause
 *     or unpause).
 *   - Doesn't write to Gmail (no label changes, no sends).
 *   - Doesn't actually trigger reprocessing — that's a deliberate
 *     manual step via the dashboard's Recover button. This script
 *     just unblocks Recover.
 *
 * Usage (dry-run, DEFAULT):
 *   railway run npx tsx scripts/remediate-stuck-recovery.ts <appointmentId>
 *
 * Usage (apply):
 *   railway run npx tsx scripts/remediate-stuck-recovery.ts <appointmentId> --apply
 *
 * Optional: pass --force-clear-message=<gmailMessageId> (repeatable)
 * to also remove processed_gmail_messages rows for those IDs. Use
 * this when you know exactly which inbound message is stuck.
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

interface ConversationMessage {
  role: string;
  content: string;
}

interface ConversationState {
  messages?: ConversationMessage[];
  [key: string]: unknown;
}

function parseArgs(argv: string[]): {
  appointmentId: string | null;
  apply: boolean;
  forceClearMessageIds: string[];
} {
  const positional: string[] = [];
  const forceClearMessageIds: string[] = [];
  let apply = false;
  for (const arg of argv.slice(2)) {
    if (arg === '--apply') {
      apply = true;
    } else if (arg.startsWith('--force-clear-message=')) {
      forceClearMessageIds.push(arg.split('=', 2)[1]);
    } else if (arg.startsWith('--')) {
      console.error(`Unknown flag: ${arg}`);
      process.exit(1);
    } else {
      positional.push(arg);
    }
  }
  return {
    appointmentId: positional[0] ?? null,
    apply,
    forceClearMessageIds,
  };
}

async function main(): Promise<void> {
  const { appointmentId, apply, forceClearMessageIds } = parseArgs(process.argv);

  if (!appointmentId) {
    console.error(
      'Usage: tsx scripts/remediate-stuck-recovery.ts <appointmentId> [--apply] [--force-clear-message=<gmailMessageId>]',
    );
    process.exit(1);
  }

  await prisma.$connect();
  console.log(`\n=== Remediation for appointment ${appointmentId} ===`);
  console.log(`Mode: ${apply ? 'APPLY (writes will commit)' : 'DRY-RUN (no writes)'}\n`);

  const appointment = await prisma.appointmentRequest.findUnique({
    where: { id: appointmentId },
    select: {
      id: true,
      status: true,
      userName: true,
      therapistName: true,
      humanControlEnabled: true,
      humanControlTakenBy: true,
      humanControlTakenAt: true,
      conversationState: true,
      updatedAt: true,
    },
  });

  if (!appointment) {
    console.error(`No appointment found with id ${appointmentId}`);
    process.exit(1);
  }

  console.log(`Appointment: ${appointment.userName} / ${appointment.therapistName} (status=${appointment.status})`);
  console.log(`Current humanControlEnabled=${appointment.humanControlEnabled} takenBy=${appointment.humanControlTakenBy}`);

  // ─── 1. DEDUPLICATE conversation_state.messages ─────────────────
  const rawState = appointment.conversationState;
  let parsed: ConversationState | null = null;
  if (rawState) {
    if (typeof rawState === 'string') {
      try { parsed = JSON.parse(rawState) as ConversationState; }
      catch (err) {
        console.error('conversation_state JSON unparseable — aborting', err);
        process.exit(1);
      }
    } else {
      parsed = rawState as unknown as ConversationState;
    }
  }

  let dedupedJson: string | null = null;
  if (parsed && Array.isArray(parsed.messages)) {
    const before = parsed.messages.length;
    const seen = new Set<string>();
    const deduped: ConversationMessage[] = [];
    for (const msg of parsed.messages) {
      // Only dedup `[Received while paused]` entries — everything else
      // (assistant responses, admin system notes, normal user emails)
      // is content-unique by virtue of timestamps or wording.
      const isPauseLog =
        msg.role === 'user' &&
        typeof msg.content === 'string' &&
        msg.content.startsWith('[Received while paused] ');
      const key = isPauseLog ? `paused:${msg.content}` : null;
      if (key && seen.has(key)) {
        continue;
      }
      if (key) seen.add(key);
      deduped.push(msg);
    }
    const removed = before - deduped.length;
    console.log(`\n--- 1. conversation_state.messages dedup ---`);
    console.log(`  Before: ${before}, after: ${deduped.length}, removed: ${removed} duplicate paused-message entries`);

    if (removed > 0) {
      const updated = { ...parsed, messages: deduped };
      dedupedJson = JSON.stringify(updated);
    } else {
      console.log(`  (no duplicates found)`);
    }
  }

  // ─── 2. CLEAR stale agent-flagged residue ───────────────────────
  console.log(`\n--- 2. Stale humanControlTakenBy residue ---`);
  const shouldClearTakenBy =
    appointment.humanControlEnabled === false &&
    appointment.humanControlTakenBy === 'agent-flagged' &&
    appointment.humanControlTakenAt !== null;

  if (shouldClearTakenBy) {
    console.log(
      `  Will clear takenBy='agent-flagged' / takenAt=${appointment.humanControlTakenAt?.toISOString()}` +
        ` (humanControlEnabled is currently false — residue confuses the dashboard)`,
    );
  } else {
    console.log(`  (nothing to clear)`);
  }

  // ─── 3. FORCE-CLEAR processedGmailMessage rows ──────────────────
  console.log(`\n--- 3. force-clear processedGmailMessage rows ---`);
  if (forceClearMessageIds.length === 0) {
    console.log(`  (no --force-clear-message=... flags supplied — skipping)`);
  } else {
    const existing = await prisma.processedGmailMessage.findMany({
      where: { id: { in: forceClearMessageIds } },
      select: { id: true, context: true, processedAt: true },
    });
    console.log(`  Requested clears: ${forceClearMessageIds.length}, existing in DB: ${existing.length}`);
    for (const row of existing) {
      console.log(`    will delete  ${row.id}  context=${row.context}  at=${row.processedAt.toISOString()}`);
    }
    const missing = forceClearMessageIds.filter((id) => !existing.find((r) => r.id === id));
    for (const id of missing) {
      console.log(`    skip (not present)  ${id}`);
    }
  }

  // ─── APPLY (if --apply) ─────────────────────────────────────────
  if (!apply) {
    console.log(`\n[DRY-RUN] No writes performed. Re-run with --apply to commit.`);
    return;
  }

  console.log(`\n--- APPLYING ---`);

  // All writes share a single transaction so a partial failure doesn't
  // leave the appointment half-remediated. Force-clear of
  // processedGmailMessage rows is included so the next reprocess-thread
  // call sees a clean slate.
  const result = await prisma.$transaction(async (tx) => {
    const updateData: Record<string, unknown> = {};
    if (dedupedJson) {
      updateData.conversationState = dedupedJson;
    }
    if (shouldClearTakenBy) {
      updateData.humanControlTakenBy = null;
      updateData.humanControlTakenAt = null;
      updateData.humanControlReason = null;
    }

    let apptUpdated = 0;
    if (Object.keys(updateData).length > 0) {
      const r = await tx.appointmentRequest.update({
        where: { id: appointmentId },
        data: updateData,
        select: { id: true },
      });
      apptUpdated = r ? 1 : 0;
    }

    let deletedProcessedRows = 0;
    if (forceClearMessageIds.length > 0) {
      const r = await tx.processedGmailMessage.deleteMany({
        where: { id: { in: forceClearMessageIds } },
      });
      deletedProcessedRows = r.count;
    }

    return { apptUpdated, deletedProcessedRows };
  });

  console.log(
    `  Done. appointment_requests rows updated: ${result.apptUpdated}, processed_gmail_messages rows deleted: ${result.deletedProcessedRows}`,
  );

  console.log(`\nNext step: open the appointment in the dashboard, click "Scan Messages" to confirm the missed message is now actionable, then click "Recover" to trigger reprocessing.`);
}

main()
  .catch((err) => {
    console.error('Remediation failed:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
