import { prisma } from '../utils/database';
import { logger } from '../utils/logger';
import { slackNotificationService } from './slack-notification.service';
import { emailProcessingService } from './email-processing.service';
import { CHASE_FOLLOWUP } from '../constants';
import { getSettingValue } from './settings.service';
import { getEmailSubject, getEmailBody } from '../utils/email-templates';
import { appointmentLifecycleService } from './appointment-lifecycle.service';

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
      const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000);
      const stuckReset = await prisma.appointmentRequest.updateMany({
        where: {
          chaseSentAt: new Date(0),
          updatedAt: { lt: twoMinutesAgo },
        },
        data: { chaseSentAt: null },
      });
      if (stuckReset.count > 0) {
        logger.warn({ checkId, resetCount: stuckReset.count }, 'Reset stuck chase sentinels');
      }

      // Find stale conversations that haven't been chased yet
      const candidates = await prisma.appointmentRequest.findMany({
        where: {
          status: { in: ['pending', 'contacted', 'negotiating'] },
          lastActivityAt: { lt: chaseThreshold },
          chaseSentAt: null, // Never chased (and not currently being sent)
          humanControlEnabled: false, // Don't chase while under human control
          closureRecommendedAt: null, // Not already recommended for closure
        },
        select: {
          id: true,
          userName: true,
          userEmail: true,
          therapistName: true,
          therapistEmail: true,
          checkpointStage: true,
          gmailThreadId: true,
          therapistGmailThreadId: true,
          lastActivityAt: true,
          conversationState: true,
        },
        take: CHASE_FOLLOWUP.MAX_CHASE_BATCH_SIZE,
      });

      if (candidates.length === 0) {
        return 0;
      }

      let chasedCount = 0;

      for (const appointment of candidates) {
        try {
          // Determine who to chase based on checkpoint stage
          const chaseTarget = this.determineChaseTarget(appointment);
          if (!chaseTarget) {
            logger.debug(
              { checkId, appointmentId: appointment.id },
              'Cannot determine chase target - skipping'
            );
            continue;
          }

          const { target, email, threadId } = chaseTarget;

          // OPTIMISTIC LOCKING: claim this appointment with a sentinel
          const lockResult = await prisma.appointmentRequest.updateMany({
            where: {
              id: appointment.id,
              chaseSentAt: null, // Only if still unclaimed
            },
            data: {
              chaseSentAt: new Date(0), // Sentinel: epoch = "sending"
            },
          });

          if (lockResult.count === 0) {
            // Another process claimed it
            continue;
          }

          try {
            const therapistFirstName = (appointment.therapistName || 'there').split(' ')[0];
            const clientFirstName = (appointment.userName || 'the client').split(' ')[0];

            // Build the chase email using templates
            let subject: string;
            let body: string;

            if (target === 'user') {
              subject = await getEmailSubject('chaseUser', {
                therapistName: appointment.therapistName,
              });
              body = await getEmailBody('chaseUser', {
                userName: appointment.userName || 'there',
                therapistName: appointment.therapistName,
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

            // Send the chase email on the existing thread
            await emailProcessingService.sendEmail({
              to: email,
              subject,
              body,
              threadId: threadId || undefined,
            });

            const now = new Date();

            // Atomic update: verify sentinel still ours, then record chase
            const updateResult = await prisma.appointmentRequest.updateMany({
              where: {
                id: appointment.id,
                chaseSentAt: new Date(0), // Must still be our sentinel
              },
              data: {
                chaseSentAt: now,
                chaseSentTo: target,
                chaseTargetEmail: email,
                checkpointStage: 'chased',
                lastActivityAt: now,
                isStale: false,
              },
            });

            if (updateResult.count === 0) {
              logger.error(
                { checkId, appointmentId: appointment.id },
                'ALERT: Chase email sent but sentinel update failed - possible duplicate'
              );
            } else {
              // Send Slack notification
              await slackNotificationService.notifyChaseFollowUp(
                appointment.id,
                appointment.userName,
                appointment.therapistName,
                target,
                Math.round((Date.now() - appointment.lastActivityAt.getTime()) / (60 * 60 * 1000))
              );

              logger.info(
                {
                  checkId,
                  appointmentId: appointment.id,
                  target,
                  email,
                  userName: appointment.userName,
                  therapistName: appointment.therapistName,
                },
                `Sent chase follow-up email to ${target}`
              );

              chasedCount++;
            }
          } catch (error) {
            // On failure, reset sentinel to null so it can be retried
            await prisma.appointmentRequest.update({
              where: { id: appointment.id },
              data: { chaseSentAt: null },
              select: { id: true },
            });

            logger.error(
              { checkId, appointmentId: appointment.id, error },
              'Failed to send chase follow-up email - will retry next cycle'
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
   */
  determineChaseTarget(appointment: {
    checkpointStage: string | null;
    userEmail: string;
    therapistEmail: string;
    gmailThreadId: string | null;
    therapistGmailThreadId: string | null;
    conversationState: unknown;
  }): { target: 'user' | 'therapist'; email: string; threadId: string | null } | null {
    const stage = appointment.checkpointStage;

    // Stages where we're waiting on the therapist
    if (
      stage === 'awaiting_therapist_availability' ||
      stage === 'awaiting_therapist_confirmation' ||
      stage === 'awaiting_meeting_link' // Therapist needs to send the meeting link
    ) {
      return {
        target: 'therapist',
        email: appointment.therapistEmail,
        threadId: appointment.therapistGmailThreadId,
      };
    }

    // Stages where we're waiting on the user
    if (stage === 'awaiting_user_slot_selection') {
      return {
        target: 'user',
        email: appointment.userEmail,
        threadId: appointment.gmailThreadId,
      };
    }

    // For initial_contact, stalled, or no checkpoint, infer from context
    if (stage === 'initial_contact' || stage === 'stalled' || !stage) {
      // Check the conversation state for who was last emailed
      const state = appointment.conversationState as { checkpoint?: { context?: { lastEmailSentTo?: string } } } | null;
      const lastEmailTo = state?.checkpoint?.context?.lastEmailSentTo;

      if (lastEmailTo === 'therapist') {
        return {
          target: 'therapist',
          email: appointment.therapistEmail,
          threadId: appointment.therapistGmailThreadId,
        };
      }

      if (lastEmailTo === 'user') {
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
      const candidates = await prisma.appointmentRequest.findMany({
        where: {
          status: { in: ['pending', 'contacted', 'negotiating'] },
          chaseSentAt: {
            gt: new Date(0), // Exclude null and sentinels (in-flight sends)
            lt: closureThreshold, // Chase sent > threshold ago
          },
          closureRecommendedAt: null, // Not already recommended
          // Ensure no activity since the chase was sent (no response received)
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
        take: CHASE_FOLLOWUP.MAX_CLOSURE_BATCH_SIZE,
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

          const reason = `No response from ${appointment.chaseSentTo} (${chasedParty}) after chase follow-up sent ${Math.round(
            (Date.now() - (appointment.chaseSentAt?.getTime() || 0)) / (60 * 60 * 1000)
          )}h ago. Total inactivity: ${inactiveHours}h.`;

          await prisma.appointmentRequest.update({
            where: { id: appointment.id },
            data: {
              closureRecommendedAt: new Date(),
              closureRecommendedReason: reason,
              closureRecommendationActioned: false,
              checkpointStage: 'closure_recommended',
            },
            select: { id: true },
          });

          // Send Slack notification recommending closure
          await slackNotificationService.notifyClosureRecommendation(
            appointment.id,
            appointment.userName,
            appointment.therapistName,
            appointment.chaseSentTo || 'unknown',
            inactiveHours,
            reason
          );

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
            gt: new Date(0), // Excludes both null and epoch sentinel
            lt: threshold, // Reminder sent > threshold ago
          },
        },
        select: {
          id: true,
          userName: true,
          therapistName: true,
        },
        take: CHASE_FOLLOWUP.MAX_CLOSURE_BATCH_SIZE,
      });

      if (candidates.length === 0) {
        return 0;
      }

      let completedCount = 0;

      for (const appointment of candidates) {
        try {
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
