/**
 * Backfill `conversation_state.checkpoint.context.lastEmailSentTo`
 * for legacy appointment_requests rows.
 *
 * Why: the dashboard's "Next action" column uses lastEmailSentTo to
 * render party-aware labels ("Awaiting availability from therapist"
 * vs the unhelpful bare "Awaiting reply"). Current writers (the agent
 * tool-loop's send_email handler) always set it, but rows that pre-
 * date that capture have null context.lastEmailSentTo and surface as
 * "Awaiting reply" in the dashboard.
 *
 * Strategy:
 *  1. Find candidate rows: conversation_state exists, has messages,
 *     and checkpoint.context.lastEmailSentTo is null.
 *  2. For each, derive the recipient using the strongest available
 *     signal:
 *       a. Most recent `email_sent` audit event for this appointment
 *          — payload.to is the authoritative recipient. (Best signal:
 *          the actual outbound destination, not an inference.)
 *       b. If no audit event, fall back to the appointment's
 *          `chaseSentTo` (set whenever a chase fired).
 *       c. If still ambiguous, fall back to the checkpoint stage:
 *          stages that mean "we're waiting on therapist X" imply we
 *          last emailed X. initial_contact and unknown stages → skip
 *          (we genuinely don't know).
 *  3. Write the inferred value into
 *     conversation_state.checkpoint.context.lastEmailSentTo via a
 *     read-modify-write transaction (optimistic-lock guarded with
 *     updatedAt to avoid clobbering concurrent agent writes).
 *
 * Idempotent: re-running skips rows that already have
 * lastEmailSentTo set. Safe to run multiple times.
 *
 * Usage:
 *   DATABASE_URL=... \
 *     JWT_SECRET=x ANTHROPIC_API_KEY=x WEBHOOK_SECRET=x \
 *     npx tsx scripts/backfill-last-email-sent-to.ts [--dry-run] [--limit N]
 *
 * Flags:
 *   --dry-run  Print what would be written without committing.
 *   --limit N  Process at most N candidates (default: 10000).
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

type CheckpointContext = {
  lastEmailSentTo?: 'user' | 'therapist';
  [key: string]: unknown;
};

type Checkpoint = {
  stage?: string;
  context?: CheckpointContext;
  [key: string]: unknown;
};

type ConversationState = {
  messages?: Array<{ role?: string; content?: string; [key: string]: unknown }>;
  checkpoint?: Checkpoint;
  [key: string]: unknown;
};

// Stages that imply we last emailed a specific party. Used as the
// weakest fallback signal (after audit events and chaseSentTo).
const STAGE_TO_LAST_EMAIL_SENT_TO: Record<string, 'user' | 'therapist'> = {
  awaiting_therapist_availability: 'therapist',
  awaiting_user_slot_selection: 'user',
  awaiting_therapist_confirmation: 'therapist',
  awaiting_meeting_link: 'therapist',
  // 'rescheduling' / 'stalled' / 'chased' / 'closure_recommended' are
  // ambiguous on their own — we fall through to chaseSentTo or skip.
  // 'initial_contact' means no agent email has been sent yet → skip.
};

function parseConversationState(raw: unknown): ConversationState | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as ConversationState;
    } catch {
      return null;
    }
  }
  if (typeof raw === 'object') return raw as ConversationState;
  return null;
}

interface Candidate {
  id: string;
  userEmail: string;
  therapistEmail: string;
  chaseSentTo: string | null;
  checkpointStage: string | null;
  conversationState: unknown;
  updatedAt: Date;
}

interface InferredResult {
  inferred: 'user' | 'therapist';
  source: 'audit_event' | 'chase_sent_to' | 'stage';
}

async function inferLastEmailSentTo(
  candidate: Candidate,
): Promise<InferredResult | null> {
  // 1. Audit events — most reliable.
  const latestEmailSent = await prisma.appointmentAuditEvent.findFirst({
    where: {
      appointmentRequestId: candidate.id,
      eventType: 'email_sent',
    },
    orderBy: { createdAt: 'desc' },
    select: { payload: true },
  });

  if (latestEmailSent?.payload) {
    const payload = latestEmailSent.payload as { to?: string } | null;
    const to = payload?.to?.toLowerCase();
    if (to === candidate.therapistEmail.toLowerCase()) {
      return { inferred: 'therapist', source: 'audit_event' };
    }
    if (to === candidate.userEmail.toLowerCase()) {
      return { inferred: 'user', source: 'audit_event' };
    }
  }

  // 2. Chase sent to — only set if a chase fired, and the chase was
  // the most recent outbound. Reasonable for chased rows.
  if (candidate.chaseSentTo === 'user' || candidate.chaseSentTo === 'therapist') {
    return { inferred: candidate.chaseSentTo, source: 'chase_sent_to' };
  }

  // 3. Stage — weakest signal, only for stages that imply the recipient.
  if (candidate.checkpointStage) {
    const fromStage = STAGE_TO_LAST_EMAIL_SENT_TO[candidate.checkpointStage];
    if (fromStage) {
      return { inferred: fromStage, source: 'stage' };
    }
  }

  return null;
}

async function backfillOne(
  candidate: Candidate,
  dryRun: boolean,
): Promise<{ updated: boolean; inferred?: InferredResult; reason?: string }> {
  const state = parseConversationState(candidate.conversationState);
  if (!state) return { updated: false, reason: 'unparseable conversation_state' };

  // Defensive: re-check that lastEmailSentTo is still null (could have
  // been written between the SELECT and now by a concurrent agent).
  const existing = state.checkpoint?.context?.lastEmailSentTo;
  if (existing === 'user' || existing === 'therapist') {
    return { updated: false, reason: 'already set' };
  }

  const inferred = await inferLastEmailSentTo(candidate);
  if (!inferred) return { updated: false, reason: 'no signal' };

  // Build the merged state — preserve everything else under the
  // checkpoint, only add/replace context.lastEmailSentTo.
  const checkpoint: Checkpoint = state.checkpoint ?? {};
  const context: CheckpointContext = checkpoint.context ?? {};
  const newState: ConversationState = {
    ...state,
    checkpoint: {
      ...checkpoint,
      context: {
        ...context,
        lastEmailSentTo: inferred.inferred,
      },
    },
  };

  if (dryRun) {
    return { updated: false, inferred, reason: 'dry-run' };
  }

  // Optimistic-lock guard: only write if updatedAt hasn't moved since
  // we read the row. If it has, a concurrent agent has touched the
  // row and may have already written lastEmailSentTo — skip this
  // candidate and let the next run pick it up if still needed.
  const result = await prisma.appointmentRequest.updateMany({
    where: { id: candidate.id, updatedAt: candidate.updatedAt },
    data: { conversationState: newState as object },
  });

  if (result.count === 0) {
    return { updated: false, reason: 'concurrent update — skipped' };
  }

  return { updated: true, inferred };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const limitArg = args.find((a) => a.startsWith('--limit='));
  const limit = limitArg ? parseInt(limitArg.split('=')[1], 10) : 10000;

  console.log(
    `Backfill starting (dryRun=${dryRun}, limit=${limit})`,
  );

  await prisma.$connect();

  // Pull candidates in JSONB. The where clause filters at the DB so
  // we don't read healthy rows. We compare the JSONB path to null
  // both ways (key missing OR explicit null) — the path operator
  // returns SQL NULL for both, hence the simple `IS NULL` check.
  const candidates = await prisma.$queryRaw<Array<{
    id: string;
    user_email: string;
    therapist_email: string;
    chase_sent_to: string | null;
    checkpoint_stage: string | null;
    conversation_state: unknown;
    updated_at: Date;
  }>>`
    SELECT id, user_email, therapist_email, chase_sent_to,
           checkpoint_stage, conversation_state, updated_at
    FROM appointment_requests
    WHERE conversation_state IS NOT NULL
      AND (
        CASE jsonb_typeof(conversation_state)
          WHEN 'object' THEN conversation_state->'checkpoint'->'context'->>'lastEmailSentTo'
          WHEN 'string' THEN ((conversation_state #>> '{}')::jsonb)->'checkpoint'->'context'->>'lastEmailSentTo'
        END
      ) IS NULL
    LIMIT ${limit}
  `;

  console.log(`Found ${candidates.length} candidate rows`);

  const stats = {
    updated: 0,
    skippedNoSignal: 0,
    skippedAlreadySet: 0,
    skippedConcurrent: 0,
    skippedOther: 0,
    bySource: { audit_event: 0, chase_sent_to: 0, stage: 0 },
  };

  for (const row of candidates) {
    const result = await backfillOne(
      {
        id: row.id,
        userEmail: row.user_email,
        therapistEmail: row.therapist_email,
        chaseSentTo: row.chase_sent_to,
        checkpointStage: row.checkpoint_stage,
        conversationState: row.conversation_state,
        updatedAt: row.updated_at,
      },
      dryRun,
    );

    if (result.updated) {
      stats.updated++;
      if (result.inferred) stats.bySource[result.inferred.source]++;
      console.log(
        `  ${row.id}: ${result.inferred?.inferred} (${result.inferred?.source})`,
      );
    } else if (result.inferred && dryRun) {
      // Dry-run hit — would have updated.
      stats.updated++;
      stats.bySource[result.inferred.source]++;
      console.log(
        `  [dry-run] ${row.id}: would set ${result.inferred.inferred} (${result.inferred.source})`,
      );
    } else if (result.reason === 'no signal') {
      stats.skippedNoSignal++;
    } else if (result.reason === 'already set') {
      stats.skippedAlreadySet++;
    } else if (result.reason === 'concurrent update — skipped') {
      stats.skippedConcurrent++;
    } else {
      stats.skippedOther++;
    }
  }

  console.log('\nBackfill complete:');
  console.log(`  Updated:           ${stats.updated}${dryRun ? ' (dry-run)' : ''}`);
  console.log(`    via audit_event: ${stats.bySource.audit_event}`);
  console.log(`    via chaseSentTo: ${stats.bySource.chase_sent_to}`);
  console.log(`    via stage:       ${stats.bySource.stage}`);
  console.log(`  Skipped (no signal):        ${stats.skippedNoSignal}`);
  console.log(`  Skipped (already set):      ${stats.skippedAlreadySet}`);
  console.log(`  Skipped (concurrent write): ${stats.skippedConcurrent}`);
  console.log(`  Skipped (other):            ${stats.skippedOther}`);
}

main()
  .catch((err) => {
    console.error('Backfill failed:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
