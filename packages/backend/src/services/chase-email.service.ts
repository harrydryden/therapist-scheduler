import { prisma } from '../utils/database';
import { logger } from '../utils/logger';
import {
  tryClaimSentinel,
  releaseSentinelClaim,
  cleanupStuckSentinels,
  EPOCH_SENTINEL,
} from '../utils/atomic-sentinel-claim';
import { slackNotificationService } from './slack-notification.service';
import { emailProcessingService } from './email-processing.service';
import { getSettingValue } from './settings.service';
import { getEmailSubject, getEmailBody } from '../utils/email-templates';
import { firstName } from '../utils/first-name';
import { isTherapistPending, isUserPending } from './stage-groups';
import { appointmentLifecycleService } from '../domain/scheduling/lifecycle';
import { aiConversationService } from './ai-conversation.service';
import { recordAppointmentEvent } from './appointment-event.service';
import { runPeriodicTrackedSideEffect } from './side-effect-harness';
import { finalizeChase } from './periodic-effect-finalizers';
import { PRE_BOOKING_STATUSES } from '../constants';

class ChaseEmailService {
  /**
   * Send chase follow-up emails to the non-responding party.
   *
   * When a conversation has been stale for a configurable period (default 72h),
   * and no chase has been sent yet, determine who hasn't responded and send
   * them a single follow-up email. The checkpoint stage tells us who we're
   * waiting for:
   *
   * - awaiting_therapist_availability / awaiting_therapist_confirmation / awaiting_meeting_link → chase therapist
   * - awaiting_user_slot_selection → chase user
   * - initial_contact / stalled / no checkpoint → infer from conversation state or thread existence
   *
   * Only one chase is ever sent per thread. If it goes unanswered, the system
   * will later recommend closure to the admin.
   *
   * Uses the same sentinel pattern as post-booking follow-ups to prevent
   * duplicate sends on process crash: null → epoch (sending) → actual timestamp.
   */
  async sendChaseFollowUps(checkId: string): Promise<number> {
    try {
      const chaseAfterHours = await getSettingValue<number>('chase.afterStaleHours');
      const chaseThreshold = new Date(Date.now() - chaseAfterHours * 60 * 60 * 1000);

      // Clean up stuck sentinels from crashed processes (>2 min old)
      const stuckCounts = await cleanupStuckSentinels(['chaseSentAt'], 2 * 60 * 1000);
      if (stuckCounts.chaseSentAt > 0) {
        logger.warn({ checkId, resetCount: stuckCounts.chaseSentAt }, 'Reset stuck chase sentinels');
      }

      // Find stale conversations that haven't been chased yet
      // Includes pre-booking statuses AND confirmed-but-rescheduling appointments.
      // Excludes appointments with an ACTIVE closure recommendation; previously
      // dismissed/actioned recommendations are fine — see dismissClosureRecommendation
      // for why we preserve closureRecommendedAt and gate on actioned instead.
      const candidates = await prisma.appointmentRequest.findMany({
        where: {
          AND: [
            {
              OR: [
                { status: { in: [...PRE_BOOKING_STATUSES] } },
                { status: 'confirmed', reschedulingInProgress: true },
              ],
            },
            {
              OR: [
                { closureRecommendedAt: null },
                { closureRecommendationActioned: true },
              ],
            },
          ],
          lastActivityAt: { lt: chaseThreshold },
          chaseSentAt: null, // Never chased (and not currently being sent)
          humanControlEnabled: false, // Don't chase while under human control
        },
        select: {
          id: true,
          userName: true,
          userEmail: true,
          therapistName: true,
          therapistEmail: true,
          checkpointStage: true,
          // Denormalised in column form (PR #268). The pre-send reply
          // check below only needs the timestamp; pulling the full
          // conversationState JSON blob (up to 500KB per row) just for
          // this one field was the largest chase-tick cost identified
          // by the DB hot-path audit.
          checkpointAt: true,
          gmailThreadId: true,
          therapistGmailThreadId: true,
          lastActivityAt: true,
          // determineChaseTarget reads conversationState.checkpoint.context.lastEmailSentTo
          // only for the `initial_contact`/`stalled`/no-checkpoint inference branch — a
          // small fraction of candidates. Read on demand below to keep the hot path lean.
        },
        take: await getSettingValue<number>('chase.maxChaseBatchSize'),
      });

      if (candidates.length === 0) {
        return 0;
      }

      let chasedCount = 0;

      for (const appointment of candidates) {
        try {
          // For most stages the chase target is determined purely from
          // `checkpointStage` (denormalised column). Only the three legacy
          // branches (`initial_contact`, `stalled`, no-checkpoint) need to
          // peek at `conversationState.checkpoint.context.lastEmailSentTo`,
          // and those are a minority of candidates. Fetch the blob on
          // demand for just those rows so the hot path stays lean.
          let lastEmailSentTo: 'user' | 'therapist' | null = null;
          const stage = appointment.checkpointStage;
          if (stage === 'initial_contact' || stage === 'stalled' || !stage) {
            const lazy = await prisma.appointmentRequest.findUnique({
              where: { id: appointment.id },
              select: { conversationState: true },
            });
            const state = lazy?.conversationState as
              | { checkpoint?: { context?: { lastEmailSentTo?: 'user' | 'therapist' } } }
              | null;
            lastEmailSentTo = state?.checkpoint?.context?.lastEmailSentTo ?? null;
          }

          // Determine who to chase based on checkpoint stage
          const chaseTarget = this.determineChaseTarget(appointment, lastEmailSentTo);
          if (!chaseTarget) {
            logger.debug(
              { checkId, appointmentId: appointment.id },
              'Cannot determine chase target - skipping'
            );
            continue;
          }

          const { target, email, threadId } = chaseTarget;

          // OPTIMISTIC LOCKING: claim this appointment via the shared
          // sentinel helper (utils/atomic-sentinel-claim.ts). Returns
          // false if another process beat us to it.
          if (!(await tryClaimSentinel(appointment.id, 'chaseSentAt'))) {
            continue;
          }

          try {
            // PRE-SEND SAFETY CHECK: Verify the Gmail thread for an inbound
            // reply that arrived AFTER the current checkpoint stage was entered.
            // The cutoff is the checkpoint's `checkpoint_at` — older inbound
            // messages are the very replies that advanced the conversation INTO
            // this stage (or pre-existed it) and have already been accounted
            // for. Per-checkpoint chasers (one chase per stage) would otherwise
            // false-positive against those legitimately-processed replies.
            //
            // A reply newer than the cutoff is genuinely concerning: either it
            // was abandoned after MAX_UNMATCHED_ATTEMPTS / MAX_PROCESSING_FAILURES,
            // or the recipient replied without our processing catching up. We
            // block the chase and alert so admins can recover by hand.
            //
            // If no checkpoint_at is present (legacy/malformed state), fall back
            // to the old "any inbound reply blocks" safety-first behaviour.
            //
            // We check both the therapist and user threads — a fresh reply on
            // either side means the conversation is not truly stale.
            const threadIdsToCheck = new Set<string>();
            if (threadId) threadIdsToCheck.add(threadId);
            if (appointment.therapistGmailThreadId) threadIdsToCheck.add(appointment.therapistGmailThreadId);
            if (appointment.gmailThreadId) threadIdsToCheck.add(appointment.gmailThreadId);

            // Read from the denormalised column populated by storeConversationState +
            // applyCheckpointUpdate (PR #268). Replaces the previous JSON path
            // extraction from `appointment.conversationState` — the row no longer
            // includes the blob, so this hot path doesn't pull MB of payload per
            // tick for one timestamp.
            const sinceMs = appointment.checkpointAt?.getTime();

            if (threadIdsToCheck.size > 0) {
              try {
                let hasReply = false;
                for (const tid of threadIdsToCheck) {
                  if (await emailProcessingService.threadContainsInboundReplies(
                    tid,
                    `chase-presend:${appointment.id}`,
                    sinceMs,
                  )) {
                    hasReply = true;
                    break;
                  }
                }

                if (hasReply) {
                  logger.warn(
                    {
                      checkId,
                      appointmentId: appointment.id,
                      target,
                      sinceMs,
                    },
                    'Thread contains inbound reply newer than current stage — skipping chase'
                  );

                  // Release the sentinel so the appointment can be re-evaluated.
                  await releaseSentinelClaim(appointment.id, 'chaseSentAt');

                  // Also attempt to recover any unprocessed messages (best-effort).
                  // This handles the case where the reply was never processed at all.
                  for (const tid of threadIdsToCheck) {
                    try {
                      await emailProcessingService.checkThreadForUnprocessedReplies(
                        tid,
                        `chase-presend-recovery:${appointment.id}`
                      );
                    } catch {
                      // Non-fatal — the important thing is we don't send the chase
                    }
                  }

                  // Alert admins so they can investigate why the reply wasn't
                  // processed successfully through normal paths. PII discipline:
                  // first name only for the user (utils/first-name.ts).
                  slackNotificationService.sendAlert({
                    title: 'Chase prevented — reply exists on thread',
                    severity: 'high',
                    appointmentId: appointment.id,
                    therapistName: appointment.therapistName,
                    details:
                      `Blocked chase to *${target}* because the Gmail thread received ` +
                      `an inbound reply after the current checkpoint stage was entered ` +
                      `and our system hasn't acted on it — investigate and manually recover.`,
                    additionalFields: {
                      'Client': firstName(appointment.userName, '(unknown)'),
                      'Chase target': target,
                    },
                  }).catch(() => {});

                  continue; // Skip to next candidate
                }
              } catch (preCheckErr) {
                // Non-fatal: if the thread check fails (OAuth issue, API error),
                // still send the chase rather than silently dropping it.
                logger.warn(
                  { checkId, appointmentId: appointment.id, error: preCheckErr },
                  'Pre-chase thread check failed — proceeding with chase send'
                );
              }
            }

            const therapistFirstName = firstName(appointment.therapistName);
            // 'the client' for the therapist-facing email body (so they
            // read "your client X"); 'there' for the user-facing greeting
            // (so they see "Hi there,").
            const clientFirstName = firstName(appointment.userName, 'the client');
            const userGreetingName = firstName(appointment.userName);

            // Build the chase email using templates. Templates address the
            // recipient by first name only — see utils/first-name.ts. Done
            // synchronously here (still inside the inner try) so a
            // template-load failure flows through the catch-block sentinel
            // release; if we deferred it to renderPayload inside the
            // harness, a render throw would prevent registration and the
            // sentinel would be stuck at EPOCH with no retry.
            let subject: string;
            let body: string;

            if (target === 'user') {
              subject = await getEmailSubject('chaseUser', {
                therapistName: therapistFirstName,
              });
              body = await getEmailBody('chaseUser', {
                userName: userGreetingName,
                therapistName: therapistFirstName,
              });
            } else {
              subject = await getEmailSubject('chaseTherapist', {
                clientFirstName,
              });
              body = await getEmailBody('chaseTherapist', {
                therapistFirstName,
                clientFirstName,
              });
            }

            const inactiveHours = Math.round(
              (Date.now() - appointment.lastActivityAt.getTime()) / (60 * 60 * 1000)
            );
            const effectType = target === 'user' ? 'email_chase_user' : 'email_chase_therapist';

            // Tracked side effect. Send + checkpoint advance + audit
            // recording all live in execute so retry replays the whole
            // unit if the process dies mid-flight. The sentinel claim
            // above still protects against concurrent ticks (the harness's
            // `pending` state doesn't block parallel execute calls), and
            // the stored payload lets retry replay the email without
            // re-rendering against drifted template settings.
            runPeriodicTrackedSideEffect(
              { kind: 'appointment', appointmentId: appointment.id },
              effectType,
              {
                renderPayload: async () => ({
                  to: email,
                  subject,
                  body,
                  threadId: threadId || undefined,
                }),
                execute: async (payload) => {
                  await emailProcessingService.sendEmail(payload);

                  // Same finalization (checkpoint advance + chase-sent
                  // metadata + audit event) runs whether this is the first
                  // attempt or a retry replaying the stored payload — see
                  // finalizeChase's own doc comment.
                  await finalizeChase({
                    appointmentId: appointment.id,
                    target,
                    targetEmail: email,
                    now: new Date(),
                    checkId,
                    userName: appointment.userName,
                    therapistName: appointment.therapistName,
                    inactiveHours,
                  });
                },
              },
              {
                name: 'chase-email',
                context: { appointmentId: appointment.id, target },
              },
            );

            // Counted at queue time, not at completion — the harness is
            // fire-and-forget. A failure inside execute is logged + retried
            // by the side-effect-retry runner; this count reflects "chases
            // queued in this tick", which is what the periodic runner
            // observability wants.
            chasedCount++;
          } catch (error) {
            // Errors from the pre-send safety check or template render
            // land here. Reset the sentinel so the appointment can be
            // re-evaluated on the next tick. Failures inside the harness
            // execute do NOT flow through this catch — the harness marks
            // its row failed and the retry runner handles them.
            await prisma.appointmentRequest.update({
              where: { id: appointment.id },
              data: { chaseSentAt: null },
              select: { id: true },
            });

            logger.error(
              { checkId, appointmentId: appointment.id, error },
              'Failed to prepare chase follow-up email - will retry next cycle'
            );
          }
        } catch (error) {
          logger.error(
            { checkId, appointmentId: appointment.id, error },
            'Failed to process chase follow-up for appointment'
          );
        }
      }

      return chasedCount;
    } catch (error) {
      logger.error({ checkId, error }, 'Failed to run chase follow-ups');
      return 0;
    }
  }

  /**
   * Determine who to chase based on the conversation's checkpoint stage.
   * Returns the target ('user' or 'therapist'), their email, and the thread ID
   * to reply on.
   *
   * `lastEmailSentTo` is only consulted for the legacy `initial_contact`/
   * `stalled`/no-checkpoint branches. Callers should pass `null` (or omit it)
   * for any other stage — the caller is responsible for the lazy fetch when
   * the legacy branch is reached, so the hot path (TherapistPending /
   * UserPending) doesn't pay for a conversationState lookup.
   */
  determineChaseTarget(
    appointment: {
      checkpointStage: string | null;
      userEmail: string;
      therapistEmail: string;
      gmailThreadId: string | null;
      therapistGmailThreadId: string | null;
    },
    lastEmailSentTo: 'user' | 'therapist' | null = null,
  ): { target: 'user' | 'therapist'; email: string; threadId: string | null } | null {
    const stage = appointment.checkpointStage;

    // Stages where we're waiting on the therapist
    if (isTherapistPending(stage)) {
      return {
        target: 'therapist',
        email: appointment.therapistEmail,
        threadId: appointment.therapistGmailThreadId,
      };
    }

    // Stages where we're waiting on the user
    if (isUserPending(stage)) {
      return {
        target: 'user',
        email: appointment.userEmail,
        threadId: appointment.gmailThreadId,
      };
    }

    // For initial_contact, stalled, or no checkpoint, infer from the lazy
    // lastEmailSentTo lookup the caller passed.
    if (stage === 'initial_contact' || stage === 'stalled' || !stage) {
      if (lastEmailSentTo === 'therapist') {
        return {
          target: 'therapist',
          email: appointment.therapistEmail,
          threadId: appointment.therapistGmailThreadId,
        };
      }

      if (lastEmailSentTo === 'user') {
        return {
          target: 'user',
          email: appointment.userEmail,
          threadId: appointment.gmailThreadId,
        };
      }

      // Default: if therapist thread exists but conversation didn't progress, chase therapist
      if (appointment.therapistGmailThreadId) {
        return {
          target: 'therapist',
          email: appointment.therapistEmail,
          threadId: appointment.therapistGmailThreadId,
        };
      }

      // If only user thread, chase user
      if (appointment.gmailThreadId) {
        return {
          target: 'user',
          email: appointment.userEmail,
          threadId: appointment.gmailThreadId,
        };
      }
    }

    // Cannot determine target (e.g., rescheduling, confirmed, or no threads)
    return null;
  }

  /**
   * Recommend closure for threads where the chase follow-up went unanswered.
   *
   * After a configurable period (default 48h) following a chase email with no
   * response, the system flags the thread for admin review with a recommendation
   * to cancel/close. The admin can then action or dismiss the recommendation.
   *
   * This ensures every conversation has a path to conclusion rather than
   * lingering indefinitely in an active state.
   */
  async recommendClosures(checkId: string): Promise<number> {
    try {
      const closureHours = await getSettingValue<number>('chase.closureRecommendationHours');
      const closureThreshold = new Date(Date.now() - closureHours * 60 * 60 * 1000);

      // Find conversations where chase was sent but no response received
      // Includes pre-booking statuses AND confirmed-but-rescheduling appointments.
      // Excludes appointments with an ACTIVE closure recommendation (one that
      // exists and hasn't been actioned yet); a previously dismissed/actioned
      // recommendation is fine — we keep the timestamp for reporting fidelity
      // and gate on closureRecommendationActioned.
      const candidates = await prisma.appointmentRequest.findMany({
        where: {
          AND: [
            {
              OR: [
                { status: { in: [...PRE_BOOKING_STATUSES] } },
                { status: 'confirmed', reschedulingInProgress: true },
              ],
            },
            {
              OR: [
                { closureRecommendedAt: null },
                { closureRecommendationActioned: true },
              ],
            },
          ],
          chaseSentAt: {
            gt: EPOCH_SENTINEL, // Exclude null and sentinels (in-flight sends)
            lt: closureThreshold, // Chase sent > threshold ago
          },
          lastActivityAt: { lt: closureThreshold },
        },
        select: {
          id: true,
          userName: true,
          userEmail: true,
          therapistName: true,
          chaseSentTo: true,
          chaseSentAt: true,
          lastActivityAt: true,
          status: true,
        },
        take: await getSettingValue<number>('chase.maxClosureBatchSize'),
      });

      if (candidates.length === 0) {
        return 0;
      }

      let closureCount = 0;

      for (const appointment of candidates) {
        try {
          const inactiveHours = Math.round(
            (Date.now() - appointment.lastActivityAt.getTime()) / (60 * 60 * 1000)
          );
          const chasedParty = appointment.chaseSentTo === 'therapist'
            ? appointment.therapistName
            : (appointment.userName || appointment.userEmail);

          const hoursSinceChase = Math.round(
            (Date.now() - appointment.chaseSentAt!.getTime()) / (60 * 60 * 1000)
          );
          const reason = `No response from ${appointment.chaseSentTo} (${chasedParty}) after chase follow-up sent ${hoursSinceChase}h ago. Total inactivity: ${inactiveHours}h.`;

          // Route the checkpoint stage update through the helper (JSON is the
          // source of truth; column is derived) alongside the closure flags.
          const closureResult = await aiConversationService.applyCheckpointAction(
            appointment.id,
            'closure_recommended_to_admin',
            {
              extraUpdates: {
                closureRecommendedAt: new Date(),
                closureRecommendedReason: reason,
                closureRecommendationActioned: false,
              },
            }
          );
          if (!closureResult.applied) {
            logger.warn(
              { checkId, appointmentId: appointment.id },
              'Closure recommendation write failed (optimistic lock conflict)'
            );
            continue;
          }

          await recordAppointmentEvent({
            appointmentId: appointment.id,
            type: 'closure_recommended',
            actor: 'system',
            reason,
            payload: {
              chasedParty: appointment.chaseSentTo || 'unknown',
              inactiveHours,
              hoursSinceChase,
              userName: appointment.userName,
              therapistName: appointment.therapistName,
            },
            slack: {
              // PII discipline: first name only for the user.
              title: 'Closure recommended',
              severity: 'high',
              details:
                `No response from *${appointment.chaseSentTo}* (${chasedParty}) ` +
                `after chase follow-up *${hoursSinceChase}h* ago. ` +
                `Total inactivity: *${inactiveHours}h*. Admin review needed.`,
              additionalFields: {
                'Client': firstName(appointment.userName, '(unknown)'),
                'Therapist': appointment.therapistName || '(unknown)',
              },
            },
          });

          logger.info(
            {
              checkId,
              appointmentId: appointment.id,
              chaseSentTo: appointment.chaseSentTo,
              inactiveHours,
              userName: appointment.userName,
              therapistName: appointment.therapistName,
            },
            'Recommended closure for unresponsive thread'
          );

          closureCount++;
        } catch (error) {
          logger.error(
            { checkId, appointmentId: appointment.id, error },
            'Failed to recommend closure for appointment'
          );
        }
      }

      return closureCount;
    } catch (error) {
      logger.error({ checkId, error }, 'Failed to run closure recommendations');
      return 0;
    }
  }

  /**
   * Auto-complete feedback_requested appointments where the feedback reminder
   * went unanswered.
   *
   * After the feedback reminder is sent and a configurable period passes with
   * no feedback submission, the appointment is automatically completed. This
   * prevents feedback_requested from being a dead-end state.
   */
  async autoCompleteFeedbackDeadEnds(checkId: string): Promise<number> {
    try {
      // Use the same delay as the chase closure recommendation (default 48h after reminder)
      const closureHours = await getSettingValue<number>('chase.closureRecommendationHours');
      const threshold = new Date(Date.now() - closureHours * 60 * 60 * 1000);

      // Find feedback_requested appointments where reminder was sent but no feedback received
      // feedbackReminderSentAt must be: not null, not epoch sentinel, and older than threshold
      const candidates = await prisma.appointmentRequest.findMany({
        where: {
          status: 'feedback_requested',
          feedbackReminderSentAt: {
            gt: EPOCH_SENTINEL, // Excludes both null and epoch sentinel
            lt: threshold, // Reminder sent > threshold ago
          },
        },
        select: {
          id: true,
          userName: true,
          therapistName: true,
        },
        take: await getSettingValue<number>('chase.maxClosureBatchSize'),
      });

      if (candidates.length === 0) {
        return 0;
      }

      let completedCount = 0;

      for (const appointment of candidates) {
        try {
          // Re-verify right before completing: an admin re-request/restore can
          // run between the candidate fetch and this point, walking the row
          // back and re-arming a FRESH feedback cycle (reminder nulled or
          // re-stamped). Acting on the stale candidate would instantly
          // re-complete an appointment the admin just revived. The residual
          // TOCTOU window is milliseconds and requires the reminder to still
          // be stale, which the sentinel resets now prevent.
          const fresh = await prisma.appointmentRequest.findUnique({
            where: { id: appointment.id },
            select: { status: true, feedbackReminderSentAt: true },
          });
          if (
            !fresh ||
            fresh.status !== 'feedback_requested' ||
            !fresh.feedbackReminderSentAt ||
            fresh.feedbackReminderSentAt.getTime() === 0 ||
            fresh.feedbackReminderSentAt >= threshold
          ) {
            logger.debug(
              { checkId, appointmentId: appointment.id },
              'Skipping feedback auto-complete — row changed since candidate fetch'
            );
            continue;
          }

          const result = await appointmentLifecycleService.transitionToCompleted({
            appointmentId: appointment.id,
            source: 'system',
            note: 'Auto-completed: no feedback received after reminder',
          });

          if (result.success) {
            completedCount++;
            logger.info(
              { checkId, appointmentId: appointment.id, userName: appointment.userName },
              'Auto-completed feedback_requested appointment (no feedback after reminder)'
            );
          }
        } catch (error) {
          logger.error(
            { checkId, appointmentId: appointment.id, error },
            'Failed to auto-complete feedback_requested appointment'
          );
        }
      }

      return completedCount;
    } catch (error) {
      logger.error({ checkId, error }, 'Failed to run feedback dead-end auto-completion');
      return 0;
    }
  }
}

export const chaseEmailService = new ChaseEmailService();
