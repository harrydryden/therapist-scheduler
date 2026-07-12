import { prisma } from '../utils/database';
import { logger } from '../utils/logger';
import { LockedPeriodicService } from '../utils/locked-periodic-service';
import type { LockedTaskContext } from '../utils/locked-task-runner';
import { getSettingValue } from './settings.service';
import { sendEmail } from '../core/email';
import { renderTemplate } from '../utils/email-templates';
import { firstName } from '../utils/first-name';
import { ACTIVE_STATUSES, TERMINAL_STATUSES, THERAPIST_NUDGE } from '../constants';
import { therapistBookingStatusService } from './therapist-booking-status.service';
import { runPeriodicTrackedSideEffect } from './side-effect-harness';
import { slackNotificationService } from './slack-notification.service';

// Check every 6 hours whether any therapists are due a nudge
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

// Distributed lock to prevent duplicate sends across instances
const LOCK_CONFIG = {
  KEY: 'therapist-nudge:processing-lock',
  TTL_SECONDS: 300,
  RENEWAL_INTERVAL_MS: 60 * 1000,
};

class TherapistNudgeService extends LockedPeriodicService<void> {
  constructor() {
    super({
      name: 'therapist-nudge',
      intervalMs: CHECK_INTERVAL_MS,
      // Delay initial run by 3 minutes to let other services initialize.
      startupDelayMs: 3 * 60 * 1000,
      lockKey: LOCK_CONFIG.KEY,
      lockTtlSeconds: LOCK_CONFIG.TTL_SECONDS,
      renewalIntervalMs: LOCK_CONFIG.RENEWAL_INTERVAL_MS,
    });
  }

  protected async tick(ctx: LockedTaskContext): Promise<void> {
    await this.sendNudges(ctx.isLockValid);
  }

  /**
   * Find therapists due for a nudge and send them an email.
   *
   * A therapist is eligible if ALL of the following are true:
   *  1. They have an ingestedAt date (were added through the ingestion flow)
   *  2. They have NO appointment thread in ANY status — active, completed, OR
   *     cancelled. A therapist who was matched to a client counts as "already
   *     has a thread" even if that booking later ended: re-nudging them
   *     ("still finding you a client") right after an admin cancels the stale
   *     conversation is exactly the counsellor-spam / lifecycle-restart bug we
   *     are guarding against. `cancelled` must be in the exclusion set because
   *     cancellation also unfreezes the therapist, so nothing else keeps them
   *     out of the candidate pool.
   *  3. Enough time has passed since ingestedAt or lastNudgeAt (whichever is later)
   *  4. They are active in Postgres (active = true)
   *  5. They are not frozen/unavailable (no active booking threads)
   */
  private async sendNudges(isLockValid: () => boolean): Promise<void> {
    const enabled = await getSettingValue<boolean>('therapistNudge.enabled');
    if (!enabled) {
      logger.debug('Therapist nudge emails disabled');
      return;
    }

    // Fetch all independent data in parallel:
    //  - settings (intervalWeeks, agentName, email templates)
    //  - appointment exclusions
    //  - active therapists from Postgres
    //  - frozen/unavailable therapist IDs
    const [
      intervalWeeks,
      agentName,
      subjectTemplate,
      bodyTemplate,
      therapistsWithAppointments,
      activeTherapists,
      unavailableIds,
    ] = await Promise.all([
      getSettingValue<number>('therapistNudge.intervalWeeks'),
      getSettingValue<string>('agent.fromName'),
      getSettingValue<string>('email.therapistNudgeSubject'),
      getSettingValue<string>('email.therapistNudgeBody'),
      // Exclude therapists who have an appointment thread in ANY status —
      // active OR terminal (completed/cancelled). ACTIVE_STATUSES ∪
      // TERMINAL_STATUSES is the full status set, so this matches "has ever
      // been in an appointment". `cancelled` was previously missing here: a
      // therapist whose only booking had just been cancelled (and thereby
      // unfrozen) fell straight back into the candidate pool and was
      // re-nudged, which is the counsellor-spam / lifecycle-restart bug.
      prisma.appointmentRequest.findMany({
        where: {
          status: { in: [...ACTIVE_STATUSES, ...TERMINAL_STATUSES] },
        },
        select: { therapistHandle: true },
        distinct: ['therapistHandle'],
      }),
      // Active therapist set (post-Notion-deprecation: read from Postgres).
      // Returns null on error so the run aborts cleanly rather than nudging
      // therapists who may have been deactivated.
      prisma.therapist.findMany({
        where: { active: true },
        select: { id: true, notionId: true },
      }).catch((err) => {
        logger.error({ err }, 'Failed to fetch active therapists for nudge filtering — aborting nudge run');
        return null;
      }),
      therapistBookingStatusService.getUnavailableTherapistIds(),
    ]);

    // If we can't determine which therapists are active, skip this run
    // to avoid sending nudges to inactive therapists
    if (!activeTherapists) {
      return;
    }

    const cutoff = new Date(Date.now() - intervalWeeks * 7 * 24 * 60 * 60 * 1000);
    const agentFirstName = firstName(agentName);

    const excludedHandles = new Set(therapistsWithAppointments.map(a => a.therapistHandle));
    // The public handle is notionId for legacy rows and the Postgres uuid
    // for post-Notion ingestions. Compose the active-set from both fields
    // so the filter below still excludes inactive therapists either way.
    const activeHandles = new Set<string>();
    for (const t of activeTherapists) {
      if (t.notionId) activeHandles.add(t.notionId);
      activeHandles.add(t.id);
    }
    const unavailableHandles = new Set(unavailableIds);

    // Find eligible therapists:
    //  - Have an ingestedAt date
    //  - Below the nudge ceiling (capped therapists are escalated once and
    //    then excluded — see THERAPIST_NUDGE.MAX_NUDGES)
    //  - Either never nudged (lastNudgeAt is null, ingestedAt before cutoff)
    //    or last nudged before the cutoff
    const candidates = await prisma.therapist.findMany({
      where: {
        ingestedAt: { not: null },
        nudgeCount: { lt: THERAPIST_NUDGE.MAX_NUDGES },
        OR: [
          {
            lastNudgeAt: null,
            ingestedAt: { lte: cutoff },
          },
          {
            lastNudgeAt: { lte: cutoff },
          },
        ],
      },
      select: {
        id: true,
        notionId: true,
        name: true,
        email: true,
        nudgeCount: true,
      },
    });

    // Filter out:
    //  - therapists with an appointment in any status — active or terminal
    //    (completed/cancelled) — i.e. they already have/had a thread
    //  - therapists not active (deactivated)
    //  - therapists that are frozen/unavailable (have active booking threads)
    //
    // The public handle is notionId for legacy rows and the Postgres uuid
    // for post-Notion ingestions; check both against each set.
    const eligible = candidates.filter(t => {
      const handle = t.notionId ?? t.id;
      return (
        !excludedHandles.has(handle) &&
        activeHandles.has(handle) &&
        !unavailableHandles.has(handle)
      );
    });

    if (eligible.length === 0) {
      logger.debug('No therapists due for nudge email');
      return;
    }

    logger.info({ count: eligible.length, intervalWeeks }, 'Sending therapist nudge emails');

    let sent = 0;
    let failed = 0;

    for (const therapist of eligible) {
      if (!isLockValid()) {
        logger.warn('Lost lock during therapist nudge — aborting');
        break;
      }

      // Captured here so the same value is written to lastNudgeAt and
      // passed to the harness as the cycle generation. The harness uses
      // it to partition the idempotency key per cycle; the retry-runner
      // abandon hook uses createdAt > this value as the guard against
      // clobbering a newer cycle's claim when releasing the sentinel.
      const claimedAt = new Date();

      try {
        // Inter-tick claim: atomically advance lastNudgeAt to claimedAt
        // and skip this therapist if another worker (or a previous
        // run of this loop, racing) already claimed it. Matches the
        // candidate query's filter (lastNudgeAt null OR <= cutoff)
        // so the claim removes the row from future candidate sets
        // for at least intervalWeeks. The harness's intra-effect
        // retry is the second layer; this is the first.
        const claimResult = await prisma.therapist.updateMany({
          where: {
            id: therapist.id,
            // Defensive: re-check the ceiling atomically with the claim so a
            // concurrent worker can't push a therapist past MAX_NUDGES.
            nudgeCount: { lt: THERAPIST_NUDGE.MAX_NUDGES },
            OR: [
              { lastNudgeAt: null },
              { lastNudgeAt: { lte: cutoff } },
            ],
          },
          data: { lastNudgeAt: claimedAt },
        });

        if (claimResult.count !== 1) {
          logger.debug(
            { therapistId: therapist.id },
            'Nudge sentinel already claimed by another worker - skipping'
          );
          continue;
        }

        const therapistFirstName = firstName(therapist.name);
        const variables = {
          therapistFirstName,
          // therapistName intentionally also resolves to the first name —
          // the user wants every email salutation to address therapists
          // by first name only. Templates that referenced the full
          // {therapistName} now render the first name too.
          therapistName: therapistFirstName,
          agentFirstName,
        };

        const subject = renderTemplate(subjectTemplate, variables);
        const body = renderTemplate(bodyTemplate, variables);

        runPeriodicTrackedSideEffect(
          { kind: 'therapist', therapistId: therapist.id },
          'email_therapist_nudge',
          {
            renderPayload: async () => ({
              to: therapist.email,
              subject,
              body,
            }),
            execute: async (envelope) => {
              const { threadId, messageId } = await sendEmail({
                to: envelope.to,
                subject: envelope.subject,
                body: envelope.body,
              });

              // Two state mutations bundled in a transaction:
              //   1. Stamp Therapist.lastNudgeAt + lastNudgeThreadId
              //      (preserved as a fallback path for the
              //      pre-phase-5 nudge slack-alert dispatcher branch
              //      — see email-message-processor).
              //   2. Abandon any prior active nudge_reply
              //      conversation for this therapist, then create a
              //      fresh one. Each nudge supersedes the previous
              //      one's untouched ask. Seeding the new row's
              //      conversationState with the outbound body as an
              //      'assistant' message means when the therapist
              //      replies, the availability agent's processReply
              //      sees a coherent [assistant, user] history
              //      rather than processing an orphaned inbound.
              //
              // Retry semantics: if this txn throws, the harness
              // marks the row failed and the retry runner replays
              // executeTherapistEffect which only re-sends the
              // email (see side-effect-retry.service.ts). The next
              // 6h cron tick will NOT re-fire the full execute
              // because the sentinel claim above moved lastNudgeAt
              // out of candidate range. So at most one txn attempt
              // per nudge — a permanent txn failure surfaces as a
              // missing/stale TherapistConversation row, not a
              // duplicate-conversation explosion.
              //
              // Exhausted-retry recovery: if all 5 attempts fail and
              // the retry runner marks this cycle's row abandoned,
              // it ALSO releases lastNudgeAt (see retry service's
              // post-abandon hook). The next cron tick then opens a
              // fresh cycle — a new claim timestamp produces a new
              // idempotency key and a new row with a fresh attempts
              // budget. So permanent failures are still bounded by
              // 5 attempts per cycle, but transient outages > 5
              // minutes can recover at the next 6h tick rather than
              // being silently dropped.
              await prisma.$transaction(async (tx) => {
                await tx.therapist.update({
                  where: { id: therapist.id },
                  data: {
                    lastNudgeAt: new Date(),
                    lastNudgeThreadId: threadId || null,
                    // Advance the ceiling counter. Bundled into the same
                    // atomic txn as lastNudgeAt so it shares the existing
                    // at-most-once-per-cycle semantics (the retry path only
                    // re-sends the email; it does not replay this txn).
                    nudgeCount: { increment: 1 },
                  },
                });

                await tx.therapistConversation.updateMany({
                  where: {
                    therapistId: therapist.id,
                    kind: 'nudge_reply',
                    status: 'active',
                  },
                  data: { status: 'abandoned' },
                });

                await tx.therapistConversation.create({
                  data: {
                    therapistId: therapist.id,
                    kind: 'nudge_reply',
                    status: 'active',
                    gmailThreadId: threadId || null,
                    initialMessageId: messageId || null,
                    conversationState: {
                      messages: [
                        { role: 'assistant', content: envelope.body },
                      ],
                    } as unknown as object,
                    messageCount: 1,
                  },
                });
              });

              logger.info(
                { therapistId: therapist.id, name: therapist.name, threadId },
                'Sent therapist nudge email + opened availability conversation',
              );
            },
          },
          {
            name: 'therapist-nudge',
            context: { therapistId: therapist.id, email: therapist.email },
          },
          claimedAt.getTime(),
        );

        // Counted at queue time — the harness owns durability + retry.
        sent++;

        // If this was the final permitted nudge, escalate to an admin once.
        // After this cycle nudgeCount reaches MAX_NUDGES, so the candidate
        // query excludes this therapist on every future tick — meaning this
        // alert fires exactly once. Fire-and-forget: a Slack failure must not
        // abort the nudge run (the cap itself has already been applied via
        // the incremented counter).
        const nudgeCountAfterSend = therapist.nudgeCount + 1;
        if (nudgeCountAfterSend >= THERAPIST_NUDGE.MAX_NUDGES) {
          void slackNotificationService
            .notifyTherapistNudgeExhausted({
              therapistName: therapist.name,
              nudgeCount: nudgeCountAfterSend,
            })
            .catch((alertErr) => {
              logger.warn(
                { alertErr, therapistId: therapist.id },
                'Failed to send therapist nudge-exhausted escalation',
              );
            });
        }
      } catch (err) {
        failed++;
        logger.error(
          { err, therapistId: therapist.id, name: therapist.name },
          'Failed to prepare therapist nudge email'
        );
        // Release the claim so the next tick can re-evaluate.
        try {
          await prisma.therapist.update({
            where: { id: therapist.id },
            data: { lastNudgeAt: null },
            select: { id: true },
          });
        } catch (resetErr) {
          logger.error(
            { err: resetErr, therapistId: therapist.id },
            'Failed to release nudge sentinel after prep failure'
          );
        }
      }
    }

    logger.info({ sent, failed, total: eligible.length }, 'Therapist nudge run complete');
  }
}

export const therapistNudgeService = new TherapistNudgeService();
