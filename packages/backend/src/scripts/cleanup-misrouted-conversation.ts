/**
 * Forensic cleanup for an appointment whose audit log / conversationState
 * was contaminated by a misrouted inbound email.
 *
 * Built specifically for the SPL-8449-7896-1 case (Anna's late email about
 * Harry's completed appointment was attributed to Maria's pending booking
 * via the legacy-fallback misroute fixed in PR #168). Generalised so it can
 * be reused if a similar misroute is ever discovered.
 *
 * Defaults to dry-run. Run with --apply to actually mutate.
 *
 * What it does:
 * 1. Loads the target appointment by tracking code or id
 * 2. Computes a cutoff timestamp (default: createdAt + 5 minutes — captures
 *    the original booking + initial agent outreach, drops everything after)
 * 3. Reports what would be removed (audit events after cutoff, conversation
 *    messages after cutoff)
 * 4. With --apply, removes them inside a transaction and optionally
 *    transitions the appointment to `cancelled` via the lifecycle service
 *
 * Examples:
 *   tsx src/scripts/cleanup-misrouted-conversation.ts --tracking SPL-8449-7896-1
 *   tsx src/scripts/cleanup-misrouted-conversation.ts --tracking SPL-8449-7896-1 --apply
 *   tsx src/scripts/cleanup-misrouted-conversation.ts --tracking SPL-8449-7896-1 --apply --cancel
 *   tsx src/scripts/cleanup-misrouted-conversation.ts --id <uuid> --cutoff 2026-05-05T12:00:00Z --apply
 */

import { Prisma } from '@prisma/client';
import { prisma } from '../utils/database';
import { logger } from '../utils/logger';
import { appointmentLifecycleService } from '../services/appointment-lifecycle.service';
import { extractConversationMeta } from '../utils/conversation-meta';
import type { ConversationState, ConversationMessage } from '../types';

interface Args {
  trackingCode?: string;
  id?: string;
  cutoffIso?: string;
  apply: boolean;
  cancel: boolean;
}

const DEFAULT_CUTOFF_BUFFER_MS = 5 * 60 * 1000; // 5 minutes after createdAt

function parseArgs(argv: string[]): Args {
  const args: Args = { apply: false, cancel: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const next = () => argv[++i];
    switch (flag) {
      case '--tracking': args.trackingCode = next(); break;
      case '--id': args.id = next(); break;
      case '--cutoff': args.cutoffIso = next(); break;
      case '--apply': args.apply = true; break;
      case '--cancel': args.cancel = true; break;
      case '--help':
      case '-h':
        printUsage();
        process.exit(0);
    }
  }
  if (!args.trackingCode && !args.id) {
    console.error('Error: --tracking or --id is required\n');
    printUsage();
    process.exit(1);
  }
  return args;
}

function printUsage(): void {
  console.log(`
Forensic cleanup for an appointment with misrouted audit/conversation data.

Required (one of):
  --tracking <code>    Tracking code, e.g. SPL-8449-7896-1
  --id <uuid>          Appointment uuid

Optional:
  --cutoff <ISO>       Keep entries up to this timestamp; default = createdAt + 5min
  --apply              Actually mutate (default is dry-run)
  --cancel             After scrubbing, transition the appointment to 'cancelled'
  -h, --help           Show this help

Default behavior (no --apply): prints what would change, makes no edits.
`.trim());
}

function looksLikeMessage(value: unknown): value is ConversationMessage {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.role === 'string' && typeof v.content === 'string';
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  // Resolve appointment
  const appointment = await prisma.appointmentRequest.findFirst({
    where: args.id
      ? { id: args.id }
      : { trackingCode: args.trackingCode! },
    select: {
      id: true,
      trackingCode: true,
      userName: true,
      userEmail: true,
      therapistName: true,
      therapistEmail: true,
      status: true,
      createdAt: true,
      updatedAt: true,
      conversationState: true,
      messageCount: true,
    },
  });

  if (!appointment) {
    console.error(`No appointment found for ${args.trackingCode ?? args.id}`);
    process.exit(2);
  }

  const cutoff = args.cutoffIso
    ? new Date(args.cutoffIso)
    : new Date(appointment.createdAt.getTime() + DEFAULT_CUTOFF_BUFFER_MS);

  if (Number.isNaN(cutoff.getTime())) {
    console.error(`Invalid --cutoff value: ${args.cutoffIso}`);
    process.exit(1);
  }

  console.log('=== Appointment ===');
  console.log(`  id:            ${appointment.id}`);
  console.log(`  trackingCode:  ${appointment.trackingCode}`);
  console.log(`  user:          ${appointment.userName} <${appointment.userEmail}>`);
  console.log(`  therapist:     ${appointment.therapistName} <${appointment.therapistEmail}>`);
  console.log(`  status:        ${appointment.status}`);
  console.log(`  created:       ${appointment.createdAt.toISOString()}`);
  console.log(`  updated:       ${appointment.updatedAt.toISOString()}`);
  console.log(`  cutoff:        ${cutoff.toISOString()}  ${args.cutoffIso ? '(explicit)' : '(default: createdAt + 5min)'}`);
  console.log();

  // Inspect audit events
  const allAuditEvents = await prisma.appointmentAuditEvent.findMany({
    where: { appointmentRequestId: appointment.id },
    orderBy: { createdAt: 'asc' },
    select: { id: true, eventType: true, actor: true, createdAt: true },
  });

  const eventsToKeep = allAuditEvents.filter(e => e.createdAt <= cutoff);
  const eventsToRemove = allAuditEvents.filter(e => e.createdAt > cutoff);

  console.log('=== Audit events ===');
  console.log(`  total:    ${allAuditEvents.length}`);
  console.log(`  keep:     ${eventsToKeep.length}  (createdAt <= cutoff)`);
  console.log(`  remove:   ${eventsToRemove.length}`);
  if (eventsToRemove.length > 0) {
    console.log('  --- to remove ---');
    for (const e of eventsToRemove) {
      console.log(`    ${e.createdAt.toISOString()}  ${e.actor.padEnd(10)} ${e.eventType}  (${e.id})`);
    }
  }
  console.log();

  // Inspect conversation state
  const stateRaw = appointment.conversationState as Prisma.JsonValue | null;
  let messagesToKeep: ConversationMessage[] = [];
  let messagesToRemove: ConversationMessage[] = [];
  let trimmedState: ConversationState | null = null;

  if (stateRaw && typeof stateRaw === 'object' && !Array.isArray(stateRaw)) {
    const state = stateRaw as unknown as ConversationState;
    if (Array.isArray(state.messages)) {
      // Conversation messages don't all carry timestamps. Where they do, use
      // the timestamp; where they don't, fall back to "keep" — better to
      // preserve potentially-real history than over-prune. Operators should
      // inspect the dry-run output and adjust the cutoff if needed.
      for (const m of state.messages) {
        if (!looksLikeMessage(m)) continue;
        const ts = m.timestamp ? new Date(m.timestamp) : null;
        if (ts && !Number.isNaN(ts.getTime()) && ts > cutoff) {
          messagesToRemove.push(m);
        } else {
          messagesToKeep.push(m);
        }
      }
      trimmedState = { ...state, messages: messagesToKeep };
    }
  }

  console.log('=== Conversation state ===');
  console.log(`  messages total:   ${messagesToKeep.length + messagesToRemove.length}`);
  console.log(`  keep (no ts or ts <= cutoff): ${messagesToKeep.length}`);
  console.log(`  remove (ts > cutoff):          ${messagesToRemove.length}`);
  if (messagesToRemove.length > 0) {
    console.log('  --- to remove (truncated content) ---');
    for (const m of messagesToRemove) {
      const preview = m.content.replace(/\s+/g, ' ').slice(0, 120);
      console.log(`    ${m.timestamp ?? '(no ts)'}  ${m.role.padEnd(10)} ${preview}${m.content.length > 120 ? '…' : ''}`);
    }
  }
  console.log();

  if (!args.apply) {
    console.log('Dry-run only. Re-run with --apply to make changes.');
    return;
  }

  if (eventsToRemove.length === 0 && messagesToRemove.length === 0 && !args.cancel) {
    console.log('Nothing to do.');
    return;
  }

  console.log('=== Applying changes ===');
  await prisma.$transaction(async (tx) => {
    if (eventsToRemove.length > 0) {
      const result = await tx.appointmentAuditEvent.deleteMany({
        where: { id: { in: eventsToRemove.map(e => e.id) } },
      });
      console.log(`  Deleted ${result.count} audit event(s).`);
    }
    if (trimmedState && messagesToRemove.length > 0) {
      const stateJson = JSON.stringify(trimmedState);
      const meta = extractConversationMeta(stateJson);
      await tx.appointmentRequest.update({
        where: { id: appointment.id },
        data: { conversationState: stateJson, ...meta },
        select: { id: true },
      });
      console.log(`  Trimmed conversationState to ${messagesToKeep.length} message(s).`);
    }
  });

  if (args.cancel) {
    console.log('  Force-cancelling appointment via lifecycle service...');
    const result = await appointmentLifecycleService.transitionToCancelled({
      appointmentId: appointment.id,
      reason: 'Forensic cleanup: appointment polluted by misrouted email; ' +
        'no real progress on this booking. See PR #168 for the matcher fix.',
      cancelledBy: 'admin',
      source: 'admin',
      adminId: 'cleanup-script',
      skipNotifications: true,
    });
    console.log(`  Cancellation result: skipped=${result.skipped ?? false}`);
  }

  console.log('Done.');
}

main()
  .catch((err) => {
    logger.error({ err }, 'cleanup-misrouted-conversation failed');
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
