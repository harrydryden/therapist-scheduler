/**
 * Top-level orchestrator for inbound Gmail message processing.
 *
 * Pipeline (sequential, short-circuits on success at each branch):
 *
 *   1. Atomic lock + dedup gate (via core/messaging/message-dedup)
 *   2. Belt-and-braces DB re-check (catches Redis flushes)
 *   3. Periodic ZSET cleanup
 *   4. Gmail fetch + parse
 *   5. Own-outbound skip (before bounce detection: our own SENT copies
 *      must never be subject-tested as bounces)
 *   6. Bounce detection (DSNs never reach the agent)
 *   7. Availability-agent routing (TherapistConversation match)
 *   8. Legacy nudge-reply detection (threadId match)
 *   9. Weekly mailing reply
 *  10. Appointment match (the main flow)
 *      a. Sender-based nudge-reply fallback
 *      b. Invitation-reply handler
 *      c. Unmatched-attempt tracking + abandon-on-max
 *  11. Human-control pre-check: a paused appointment skips 12-13 and
 *      goes straight to the agent, which logs the reply for the admin;
 *      the message is then recorded as deferred (paused-deferral.ts) so
 *      later polls skip it until control is released
 *  12. Closure auto-dismiss
 *  13. Thread divergence detection + retry/abandon
 *  14. Thread-history fetch
 *  15. Agent invocation
 *  16. Mark processed (or record the paused deferral) + clear failure record
 *
 * Auto-submitted / out-of-office replies are recorded and never reach an
 * agent (auto-reply.ts). Every TERMINAL outcome (marked processed) also
 * clears the message's UNREAD label so the backup poll's unread window is
 * not filled with messages that will never be processed again.
 *
 * Failure handling: ConcurrentModificationError is treated as benign
 * retry; everything else is tracked via processing-failures with the
 * `MAX_PROCESSING_FAILURES` budget. First failure emits a Slack alert
 * with the actual error text. Final failure (budget exhausted) emits
 * a high-severity Slack alert and marks the message permanently
 * processed.
 *
 * Locking: Redis lock with 5-minute TTL, renewed every 60 seconds for
 * long-running threads / Claude calls. On Redis outage, falls through
 * to a DB lease (message-dedup.ts) that is renewed the same way and
 * released on EVERY return — it is not the dedup record, so a paused,
 * deferred, unmatched or retried message stays eligible for retry.
 */

import { logger } from '../../../utils/logger';
import { prisma } from '../../../utils/database';
import { redis } from '../../../utils/redis';
import { releaseLock } from '../../../utils/redis-locks';
import {
  parseEmailMessage,
  type EmailMessage,
} from '../../../utils/email-mime-parser';
import { runWithTrace, extendTraceContext } from '../../../utils/request-tracing';
import { ConcurrentModificationError } from '../../../errors';
import { isTransientInfrastructureError } from './transient-errors';
import { EMAIL, EMAIL_PROCESSING, PRE_BOOKING_STATUSES } from '../../../constants';
import { isGmail404 } from '../../../utils/gmail-errors';
import { classifyEmail } from '../../../services/email-classifier.service';
import { emailBounceService } from '../../../services/email-bounce.service';
import { slackNotificationService } from '../../../services/slack-notification.service';
import { emailOAuthService, executeGmailWithProtection } from '../../../services/email-oauth.service';
import { threadFetchingService } from '../../../services/thread-fetching.service';
import { stripQuotedReply } from '../../../core/email/inbound/quoted-text';
import {
  findMatchingAppointmentRequest,
  findMatchingTherapistConversation,
  senderIsPartyWhere,
} from '../../../utils/thread-matcher';
import { tryHandleInvitationReply } from '../../../services/invitation-reply.service';
import { CLEANUP_CHECK_AND_RESET_SCRIPT } from '../../../utils/redis-scripts';
import type { EmailContext, AppointmentContext } from '../../../services/thread-divergence.service';

import {
  acquireMessageLock,
  isMessageProcessed,
  markMessageProcessed,
  releaseDbLock,
  renewDbLock,
  shouldEmitProcessingAlert,
  type ProcessedContext,
} from '../../../core/messaging/message-dedup';

import { createLeaseRenewal, createLockRenewal } from '../../../core/email/inbound/lock-renewal';
import { getAgentProcessor } from './agent-processor';
import { routeToAvailabilityAgent } from './availability-routing';
import {
  alertAdminOfNudgeReply,
  detectNudgeReplyBySender,
  detectNudgeReplyByThreadId,
} from './nudge-reply';
import { isWeeklyMailingReply, processWeeklyMailingReply } from './weekly-mailing';
import { maybeDismissClosureRecommendation } from './closure-auto-dismiss';
import { checkAndHandleDivergence, type DivergenceOutcome } from './divergence-handling';
import { detectAutoReply } from './auto-reply';
import {
  isUnderHumanControl,
  recordPausedDeferral,
  skipIfDeferredWhilePaused,
} from './paused-deferral';
import {
  abandonUnmatched,
  trackUnmatchedAttempt,
} from './unmatched-attempts';
import {
  clearProcessingFailure,
  markFailureAbandoned,
  trackProcessingFailure,
} from '../../../core/email/inbound/processing-failures';

const {
  PROCESSED_MESSAGES_KEY,
  MESSAGE_LOCK_PREFIX,
  PROCESSED_MESSAGE_TTL_DAYS,
  MAX_UNMATCHED_ATTEMPTS,
  MAX_PROCESSING_FAILURES,
  CLEANUP_INTERVAL_MESSAGES,
  CLEANUP_COUNTER_KEY,
} = EMAIL_PROCESSING;

/**
 * Process a single email message.
 *
 * Returns true when the message reached a meaningful handled state
 * (processed by the agent, identified as a bounce, identified as own-
 * outbound, abandoned after retries, etc.); false when the message
 * should be retried later (lock held by another worker, unmatched
 * but under the retry budget, transient errors).
 */
export async function processMessage(messageId: string, traceId: string): Promise<boolean> {
  // Wrap in a trace context so every log line emitted by anything we
  // await auto-picks up traceId. appointmentId is added to the context
  // via extendTraceContext below once the appointment is matched.
  return runWithTrace({ traceId, source: 'message-processor' }, async () => {
    // STEP 1: atomic lock + dedup gate.
    const lockResult = await acquireMessageLock(messageId, traceId);

    if (lockResult.outcome === 'already_processed' || lockResult.outcome === 'already_processed_db_fallback') {
      logger.debug({ traceId, messageId }, 'Message already processed');
      return false;
    }
    if (lockResult.outcome === 'held_by_other') {
      logger.debug({ traceId, messageId }, 'Message is being processed by another worker, skipping');
      return false;
    }

    const dbLeaseToken = lockResult.outcome === 'acquired_db_fallback' ? lockResult.leaseToken : null;
    const usingDatabaseFallback = dbLeaseToken !== null;

    // STEP 2: lock renewal — the Redis lock, or the DB lease while Redis
    // is down (both expire after 5 minutes unless renewed).
    const lockKey = `${MESSAGE_LOCK_PREFIX}${messageId}`;
    const onLockLost = () => {
      logger.error(
        { traceId, messageId },
        'Lock lost during processing - another worker may have started processing',
      );
    };
    const lockRenewal = dbLeaseToken !== null
      ? createLeaseRenewal(() => renewDbLock(messageId, dbLeaseToken), `db-lease:${messageId}`, onLockLost)
      : createLockRenewal(lockKey, traceId, onLockLost);

    // Terminal outcomes clear the message's UNREAD label (in `finally`).
    // `hadUnreadLabel` comes from the Gmail fetch, so the modify call is
    // only made for messages that are actually unread.
    let clearUnread = false;
    let hadUnreadLabel = false;
    const markTerminal = async (context: ProcessedContext): Promise<void> => {
      await markMessageProcessed(messageId, context);
      clearUnread = true;
    };

    try {
      // STEP 3: belt-and-braces DB re-check. If Redis was just cleared
      // (e.g. ZSET TTL eviction race), the lock acquire would have
      // succeeded but the message might already have a permanent DB
      // record. Re-check and cache-backfill in that case.
      if (!usingDatabaseFallback) {
        if (await isMessageProcessed(messageId)) {
          logger.debug({ traceId, messageId }, 'Message already processed (DB fallback re-check)');
          // Re-add to Redis ZSET for faster future checks. We only
          // touch the cache here — the DB record is already
          // authoritative with whatever context it was originally
          // marked under. Awaited (matches pre-refactor semantics)
          // so a subsequent processMessage on the same id within
          // milliseconds is guaranteed to hit the Redis fast-path
          // rather than racing the backfill.
          try {
            await redis.zadd(PROCESSED_MESSAGES_KEY, Date.now(), messageId);
          } catch (err) {
            logger.debug({ traceId, messageId, err }, 'Failed to backfill Redis ZSET (non-fatal)');
          }
          return false;
        }

        // Periodic cleanup: atomic check-and-reset to prevent
        // double-cleanup races. The Lua script atomically increments,
        // checks against the threshold, and resets the counter.
        try {
          const shouldCleanup = await redis.eval(
            CLEANUP_CHECK_AND_RESET_SCRIPT,
            1,
            CLEANUP_COUNTER_KEY,
            CLEANUP_INTERVAL_MESSAGES.toString(),
          );
          if (shouldCleanup === 1) {
            const cutoffTime = Date.now() - PROCESSED_MESSAGE_TTL_DAYS * 24 * 60 * 60 * 1000;
            await redis.zremrangebyscore(PROCESSED_MESSAGES_KEY, '-inf', cutoffTime).catch(() => {});
            logger.debug({ traceId }, 'Ran periodic cleanup of processed messages');
          }
        } catch {
          // Cleanup is best-effort; Redis flap shouldn't abort processing.
        }
      }

      // STEP 3b: a message deferred while its appointment is under human
      // control is skipped — before any Gmail work — until control is
      // released (E10). The poll used to re-run the whole pipeline for it
      // every 3 minutes.
      if (await skipIfDeferredWhilePaused(messageId, traceId)) {
        return false;
      }

      // STEP 4: Gmail fetch + MIME parse.
      //
      // Gmail returns 404 ("Requested entity was not found") when the
      // message has been deleted between the scanner enqueueing it
      // and us getting here — typically because the mailbox owner
      // cleared it, the spam classifier hard-deleted it, or
      // permissions changed. Retrying won't recover an entity that
      // no longer exists, so short-circuit to abandonment instead
      // of burning the 3-attempt retry budget AND triggering a
      // spurious "Message Processing Failed" Slack alert. This is
      // the same pattern the sibling `services/thread-fetching` +
      // `services/email-ingest` modules already use for thread 404s.
      const gmail = await emailOAuthService.ensureGmailClient();
      let messageResponse;
      try {
        messageResponse = await executeGmailWithProtection(
          'fetch-message',
          () => gmail.users.messages.get({
            userId: 'me',
            id: messageId,
            format: 'full',
          }),
        );
      } catch (err) {
        if (isGmail404(err)) {
          logger.info(
            { traceId, messageId },
            'Message no longer exists in Gmail (404) — marking as abandoned without retry',
          );
          await markMessageProcessed(messageId, 'message-not-found-in-gmail');
          return false;
        }
        throw err;
      }
      hadUnreadLabel = (messageResponse.data.labelIds ?? []).includes('UNREAD');

      const email = parseEmailMessage(messageResponse.data);
      if (!email) {
        logger.warn({ traceId, messageId }, 'Failed to parse email - marking as processed to avoid retry loop');
        await markTerminal('unparseable');
        return false;
      }

      logger.info(
        { traceId, messageId, from: email.from, subject: email.subject },
        'Processing email',
      );

      // STEP 5: skip our own outbound emails (these come back in via
      // Gmail webhooks but were sent BY us, not TO us). Runs BEFORE
      // bounce detection so our own SENT copies — whose subjects we
      // wrote — are never tested against the bounce patterns.
      if (email.from.toLowerCase() === EMAIL.FROM_ADDRESS.toLowerCase()) {
        logger.info(
          { traceId, messageId, from: email.from },
          'Skipping own outgoing email - not processing as incoming',
        );
        await markTerminal('own-email');
        return false;
      }

      // STEP 6: bounce detection. A hard bounce on a thread we own
      // cancels the (pre-booking) appointment and unfreezes the
      // therapist. Every other DSN — delay notices, soft / unknown
      // failures, bounces we declined to action (admins are alerted
      // inside processPotentialBounce) — is recorded and stops here: a
      // delivery-status notification is not a reply from the client or
      // therapist and must never be handed to the agent.
      const bounce = await emailBounceService.processPotentialBounce({
        from: email.from,
        subject: email.subject,
        body: email.body,
        autoSubmitted: email.autoSubmitted,
        isDeliveryStatusReport: email.isDeliveryStatusReport,
        deliveryStatus: email.deliveryStatus,
        threadId: email.threadId,
        messageId,
      });
      if (bounce.isBounce) {
        await markTerminal('bounce');
        if (bounce.cancelled) {
          logger.info(
            { traceId, messageId, from: email.from },
            'Email bounce detected and handled - therapist unfrozen',
          );
          return true;
        }
        logger.info(
          { traceId, messageId, from: email.from, bounceType: bounce.bounceType },
          'Delivery-status notification recorded without auto-cancel - not routing to agent',
        );
        return false;
      }

      // STEP 6b: auto-reply gate (§4.3). RFC 3834 auto-submitted mail and
      // out-of-office replies never get an agent turn — the same rule the
      // invitation-reply path applies. Admins still see appointment OOOs
      // via a low-severity alert (the agent's special-handling alert used
      // to cover this).
      const autoReplySignal = detectAutoReply(email);
      if (autoReplySignal) {
        await handleAutoReply(email, messageId, traceId, autoReplySignal);
        await markTerminal('auto-reply');
        return true;
      }

      // STEP 7: availability-agent routing (Phase 5). Runs BEFORE the
      // legacy lastNudgeThreadId Slack-alert path so post-phase-5
      // nudge replies — which have a TherapistConversation row —
      // route to the agent rather than triggering an admin alert.
      // Pre-phase-5 nudges (no row) fall through.
      // A processReply failure THROWS out of routeToAvailabilityAgent to
      // the outer catch (failure tracking + retry budget + alerts) rather
      // than falling through to the nudge / appointment branches below,
      // which would misroute or silently abandon the reply (E9).
      const earlyConvoMatch = await findMatchingTherapistConversation(email);
      if (earlyConvoMatch) {
        const handled = await routeToAvailabilityAgent(email, earlyConvoMatch, messageId, traceId);
        if (handled) {
          // Every handled branch of the routing marked the message processed.
          clearUnread = true;
          return true;
        }
      }

      // STEP 8: legacy nudge-reply detection (threadId match).
      // Pre-phase-5 nudges have no TherapistConversation row so the
      // step above misses; this catches them and routes to admin
      // notification instead of an appointment thread. Once the
      // legacy nudges age out, this branch can be removed.
      if (email.threadId) {
        const nudgeTherapist = await detectNudgeReplyByThreadId(email.threadId);
        if (nudgeTherapist) {
          logger.info(
            { traceId, messageId, from: email.from, therapistId: nudgeTherapist.id, therapistName: nudgeTherapist.name },
            'Detected reply to therapist nudge email — routing to admin notification instead of appointment matching',
          );
          alertAdminOfNudgeReply({
            therapist: nudgeTherapist,
            subject: email.subject,
            reason: 'thread-id-match',
            traceId,
          });
          await markTerminal('therapist-nudge-reply');
          return true;
        }
      }

      // STEP 9: weekly promotional mailing replies.
      if (await isWeeklyMailingReply(email)) {
        const handled = await processWeeklyMailingReply(email, messageId, traceId);
        if (handled) {
          await markTerminal('weekly-mailing-reply');
          return true;
        }
        // Fall through to normal appointment matching if not handled.
      }

      // STEP 10: appointment match.
      const appointmentRequest = await findMatchingAppointmentRequest(email);

      if (!appointmentRequest) {
        // STEP 10a: sender-based nudge-reply fallback. The primary
        // threadId-based detection can fail when Gmail assigns the
        // reply a different thread ID — common for replies arriving
        // days/weeks later. Subject-line heuristic + "no active
        // appointments" make this high-confidence.
        const nudgeFallback = await detectNudgeReplyBySender(email, traceId);
        if (nudgeFallback) {
          logger.info(
            { traceId, messageId, from: email.from, therapistId: nudgeFallback.id, therapistName: nudgeFallback.name },
            'Detected nudge reply via sender fallback (threadId mismatch) — routing to admin notification',
          );
          alertAdminOfNudgeReply({
            therapist: nudgeFallback,
            subject: email.subject,
            reason: 'sender-fallback',
            traceId,
          });
          await markTerminal('therapist-nudge-reply');
          return true;
        }

        // STEP 10b: invitation auto-reply path. People we sent a
        // SignupInvitation to sometimes reply with questions before
        // booking. The agent answers from the knowledge base or
        // directs them to the web app.
        const handledAsInvitationReply = await tryHandleInvitationReply(email, traceId);
        if (handledAsInvitationReply) {
          await markTerminal('invitation-reply');
          return true;
        }

        // STEP 10c: unmatched-attempt tracking. After
        // MAX_UNMATCHED_ATTEMPTS within the TTL window, mark as
        // processed to break the infinite retry loop.
        const attempts = await trackUnmatchedAttempt(messageId);

        if (attempts >= MAX_UNMATCHED_ATTEMPTS) {
          logger.warn(
            { traceId, messageId, from: email.from, subject: email.subject, attempts },
            'Email unmatched after max attempts - marking as processed to prevent infinite loop',
          );

          await Promise.all([
            markTerminal('unmatched-abandoned'),
            abandonUnmatched(messageId),
          ]);

          // Alert admins — an unmatched email likely means a reply was
          // silently dropped and needs manual review.
          slackNotificationService.notifyUnmatchedEmailAbandoned({
            messageId,
            from: email.from,
            subject: email.subject,
            attempts,
          }).catch((err) => {
            logger.warn({ traceId, err }, 'Failed to send Slack alert for unmatched email');
          });

          return false;
        }

        logger.info(
          { traceId, messageId, from: email.from, subject: email.subject, attempts, maxAttempts: MAX_UNMATCHED_ATTEMPTS },
          'No matching appointment request found - will retry on next poll',
        );
        return false;
      }

      // Extend the request context with the matched appointmentId so
      // every log line from here on auto-includes it via the pino
      // mixin.
      extendTraceContext({ appointmentId: appointmentRequest.id });

      logger.info(
        { traceId, messageId, appointmentRequestId: appointmentRequest.id },
        'Found matching appointment request',
      );

      // STEP 11: human-control pre-check. A paused appointment's reply goes
      // straight to the agent (which logs it for the admin without a turn);
      // closure auto-dismiss and divergence tracking run when it is
      // replayed after release, not while paused.
      const paused = await isUnderHumanControl(appointmentRequest.id);

      // Classify the inbound (used by both the closure auto-dismiss gate
      // and the agent path below — pass via precomputedClassification so
      // the agent doesn't redo the work). Quoted history is stripped first:
      // the classifier must react to what the sender wrote, not to our own
      // earlier wording quoted underneath it.
      const earlyClassification = classifyEmail(
        stripQuotedReply(email.body),
        email.from,
        appointmentRequest.therapistEmail,
        appointmentRequest.userEmail,
        email.autoSubmitted,
      );

      if (!paused) {
        const divergenceOutcome = await runPreAgentChecks({
          email,
          appointmentRequest,
          classification: earlyClassification,
          messageId,
          traceId,
        });
        if (divergenceOutcome === 'abandoned') {
          clearUnread = true; // marked processed by the divergence module
        }
        if (divergenceOutcome !== 'proceed') {
          return false;
        }
      }

      // STEP 14: fetch thread history for full agent context.
      let threadContext: string | undefined;
      if (email.threadId) {
        try {
          const thread = await threadFetchingService.fetchThreadById(email.threadId, traceId);
          if (thread && thread.messages.length > 0) {
            threadContext = threadFetchingService.formatThreadForAgent(
              thread,
              appointmentRequest.userEmail,
              appointmentRequest.therapistEmail,
            );
            logger.info(
              { traceId, messageId, threadId: email.threadId, messageCount: thread.messageCount },
              'Thread history fetched for context',
            );
          }
        } catch (threadError) {
          logger.warn(
            { traceId, messageId, threadId: email.threadId, error: threadError },
            'Failed to fetch thread history - processing with single email only',
          );
        }
      }

      // STEP 15: hand to the AI agent.
      const agentProcessor = getAgentProcessor(traceId);
      const agentResult = await agentProcessor.processEmailReply(
        appointmentRequest.id,
        email.body,
        email.from,
        threadContext,
        earlyClassification,
      );

      // STEP 16: success path — mark processed, clear failure record
      // (the UNREAD label is removed in `finally`).
      //
      // EXCEPTION: when the agent paused itself because human control
      // is on (`loggedWhilePaused: true`), we deliberately DON'T mark
      // the message as processed. Leaving it unmarked lets the
      // missed-message-scanner (or the release-control inline replay)
      // re-deliver it to the agent once human control is off. Marking
      // it as `'successfully-processed'` here was the bug that
      // caused stalled-after-bulk-release conversations — the
      // scanner skips already-marked messages, so paused replies
      // never reached the agent after release. Failure tracking
      // stays cleared either way — the message wasn't a failure,
      // just deferred.
      if (agentResult?.loggedWhilePaused !== true && agentResult?.deferredForRetry !== true) {
        await markMessageProcessed(messageId, 'successfully-processed');
      } else if (agentResult?.deferredForRetry === true) {
        logger.info(
          { traceId, messageId, appointmentId: appointmentRequest.id },
          'Skipping markMessageProcessed — agent deferred this turn, will be re-delivered later',
        );
      } else {
        logger.info(
          { traceId, messageId, appointmentId: appointmentRequest.id },
          'Skipping markMessageProcessed — message logged while paused, will be re-delivered after human-control release',
        );
        // Remember it so later polls skip it (no Gmail fetch, no repeated
        // audit event / Slack alert) until control is released.
        await recordPausedDeferral(messageId, appointmentRequest.id);
      }
      await clearProcessingFailure(messageId);

      // The agent path has always cleared UNREAD, including for paused and
      // deferred messages (the release replay and the scanner work from the
      // DB dedup table, not the label).
      clearUnread = true;

      return true;
    } catch (error) {
      // ConcurrentModificationError is BENIGN. Happens when another
      // process updates the appointment row while the agent is
      // mid-save. Retry, not abandon.
      if (error instanceof ConcurrentModificationError) {
        logger.info(
          { traceId, messageId, errorMessage: error.message },
          'Optimistic-lock conflict during processMessage — returning false without counting as failure; scanner will retry on next cycle',
        );
        return false;
      }

      const errorMessage = error instanceof Error ? error.message : String(error);

      // Infrastructure failures (breaker open, rate limit, timeout, 5xx,
      // network / DB connectivity) are NOT this message's fault. Defer
      // without consuming one of the MAX_PROCESSING_FAILURES attempts so a
      // short Claude or Gmail incident cannot permanently abandon every
      // email that arrived during it. The poller / scanner re-drive the
      // message once the dependency recovers. Visibility is preserved by a
      // deduped Slack alert.
      if (isTransientInfrastructureError(error)) {
        logger.warn(
          { traceId, messageId, errorMessage, errorName: error instanceof Error ? error.name : typeof error },
          'Transient infrastructure failure during processMessage — deferring without counting against the abandon budget',
        );
        if (await shouldEmitProcessingAlert(messageId)) {
          slackNotificationService.sendAlert({
            title: 'Message Processing Deferred (infrastructure)',
            severity: 'medium',
            details:
              'A Gmail message could not be processed because a dependency was unavailable ' +
              '(circuit breaker open, rate limit, timeout or upstream error). It has NOT been ' +
              'counted against the abandon budget and will be retried automatically.\n\n' +
              `\`\`\`${errorMessage.slice(0, 1500)}\`\`\``,
            additionalFields: { 'Message ID': messageId },
          }).catch((slackErr) => {
            logger.warn({ traceId, slackErr }, 'Failed to send deferred-processing Slack alert');
          });
        }
        return false;
      }

      let attempts: number;
      try {
        attempts = await trackProcessingFailure(messageId, errorMessage);
      } catch (trackErr) {
        // DB write failed — abandon this attempt cycle but log loudly
        // so the operator sees that failure tracking itself is broken.
        logger.error(
          { trackErr, traceId, messageId, originalError: error },
          'CRITICAL: Failed to record processing failure in DB. Scanner abandonment is degraded.',
        );
        return false;
      }

      logger.error(
        { error, traceId, messageId, attempts, maxAttempts: MAX_PROCESSING_FAILURES, errorMessage },
        `Failed to process message (attempt ${attempts}/${MAX_PROCESSING_FAILURES})`,
      );

      // First-failure visibility: send one Slack alert per (messageId,
      // dedup window) with the actual error text so admins see the
      // real cause immediately instead of waiting for 3 silent hours.
      if (await shouldEmitProcessingAlert(messageId)) {
        slackNotificationService.sendAlert({
          title: 'Message Processing Failed',
          severity: 'medium',
          details:
            `A Gmail message failed to process. It will retry up to ${MAX_PROCESSING_FAILURES} times ` +
            'before being abandoned. Error details below.\n\n' +
            `\`\`\`${errorMessage.slice(0, 1500)}\`\`\``,
          additionalFields: {
            'Message ID': messageId,
            'Attempt': `${attempts}/${MAX_PROCESSING_FAILURES}`,
          },
        }).catch((slackErr) => {
          logger.warn({ traceId, slackErr }, 'Failed to send first-failure Slack alert');
        });
      }

      // After max attempts, abandon the message to break the scanner loop.
      if (attempts >= MAX_PROCESSING_FAILURES) {
        logger.error(
          { traceId, messageId, attempts, errorMessage },
          'Message processing abandoned after max attempts',
        );

        try {
          await markTerminal('processing-failed-abandoned');
          await markFailureAbandoned(messageId);
        } catch (markErr) {
          logger.error({ traceId, messageId, markErr }, 'Failed to mark abandoned message as processed');
        }

        slackNotificationService.sendAlert({
          title: 'Message Processing Abandoned',
          severity: 'high',
          details:
            `A Gmail message failed to process after *${attempts}* attempts and has been abandoned ` +
            'to prevent the scanner from looping. Manual review required.\n\n' +
            `\`\`\`${errorMessage.slice(0, 1500)}\`\`\``,
          additionalFields: {
            'Message ID': messageId,
            'Attempts': String(attempts),
          },
        }).catch((slackErr) => {
          logger.warn({ traceId, slackErr }, 'Failed to send abandonment Slack alert');
        });
      }

      return false;
    } finally {
      lockRenewal.stop();

      if (clearUnread && hadUnreadLabel) {
        await removeUnreadLabel(messageId, traceId);
      }

      // Only attempt release if we still own the lock — prevents
      // race condition where renewal detects lock loss but finally
      // block still tries to release.
      if (!lockRenewal.isLockValid()) {
        logger.info(
          { traceId, messageId },
          'Lock no longer owned (detected by renewal) - skipping release',
        );
      } else if (dbLeaseToken !== null) {
        // The DB lease is released on EVERY return (success included): it
        // is not the dedup record — markMessageProcessed wrote that for
        // terminal outcomes, and non-terminal ones must stay retryable.
        await releaseDbLock(messageId, dbLeaseToken, traceId);
      } else {
        await releaseLock(lockKey, traceId, `email-processing:${messageId}`);
      }
    }
  });
}

/**
 * Clear the UNREAD label of a message that reached a terminal state. The
 * backup poll's first pass lists only unread inbox mail (a fixed number
 * of slots); a message that will never be processed again must not keep
 * occupying one. Cosmetic and best effort — the dedup record is already
 * committed, so a failure here must not reach the failure-tracking path.
 * 404 means the message was deleted in the meantime.
 */
async function removeUnreadLabel(messageId: string, traceId: string): Promise<void> {
  try {
    const gmailClient = await emailOAuthService.ensureGmailClient();
    await gmailClient.users.messages.modify({
      userId: 'me',
      id: messageId,
      requestBody: { removeLabelIds: ['UNREAD'] },
    });
  } catch (err) {
    if (isGmail404(err)) {
      logger.info({ traceId, messageId }, 'Message deleted before UNREAD-label removal — skipping label modify');
    } else {
      logger.warn({ traceId, messageId, err }, 'Failed to remove UNREAD label (non-fatal — outcome already recorded)');
    }
  }
}

/**
 * Record an auto-reply without an agent turn. When it belongs to an
 * appointment, raise a low-severity, per-appointment-deduped alert so an
 * admin still learns that (say) the therapist is away.
 */
async function handleAutoReply(
  email: EmailMessage,
  messageId: string,
  traceId: string,
  signal: string,
): Promise<void> {
  logger.info(
    { traceId, messageId, from: email.from, subject: email.subject, signal, autoSubmitted: email.autoSubmitted },
    'Auto-submitted / out-of-office reply — recorded without an agent turn',
  );
  try {
    const appointment = await findMatchingAppointmentRequest(email);
    if (!appointment) return;
    slackNotificationService.sendAlert({
      title: 'Out-of-office reply received',
      severity: 'low',
      appointmentId: appointment.id,
      dedupGroup: 'auto-reply',
      details:
        `An automatic reply arrived from the ${email.from.toLowerCase() === appointment.therapistEmail.toLowerCase() ? 'therapist' : 'client'}. ` +
        'It was not passed to the agent (no reply is sent to autoresponders).',
    }).catch((err) => logger.warn({ traceId, err }, 'Failed to send auto-reply Slack alert'));
  } catch (err) {
    logger.warn({ traceId, messageId, err }, 'Could not look up the appointment for an auto-reply (non-fatal)');
  }
}

/**
 * STEPS 12-13 for an appointment that is NOT under human control:
 * closure auto-dismiss, then thread-divergence detection. Returns the
 * divergence outcome ('proceed' to continue to the agent).
 */
async function runPreAgentChecks(args: {
  email: EmailMessage;
  appointmentRequest: { id: string; userEmail: string; therapistEmail: string };
  classification: ReturnType<typeof classifyEmail>;
  messageId: string;
  traceId: string;
}): Promise<DivergenceOutcome> {
  const { email, appointmentRequest, classification: earlyClassification, messageId, traceId } = args;

  // STEP 12: closure auto-dismiss (gated on not-auto-reply).
  await maybeDismissClosureRecommendation({
    appointmentId: appointmentRequest.id,
    email,
    classification: earlyClassification,
    messageId,
    traceId,
  });

  // STEP 13: thread-divergence detection. Fetch all active
  // appointments for this user/therapist so the detector can
  // check for cross-thread issues.
  // Case-insensitive (E14): stored emails keep the case the user
  // typed; an exact match came back empty and silently disabled the
  // cross-appointment divergence checks.
  const allActiveAppointments = await prisma.appointmentRequest.findMany({
    where: {
      OR: senderIsPartyWhere(email.from),
      status: { in: [...PRE_BOOKING_STATUSES, 'confirmed'] },
    },
    select: {
      id: true,
      userEmail: true,
      therapistEmail: true,
      therapistName: true,
      therapistId: true,
      therapistHandle: true,
      gmailThreadId: true,
      therapistGmailThreadId: true,
      initialMessageId: true,
      status: true,
      createdAt: true,
    },
  });

  const emailContext: EmailContext = {
    threadId: email.threadId,
    messageId: email.id,
    from: email.from,
    to: email.to,
    cc: email.cc,
    subject: email.subject,
    body: email.body,
    inReplyTo: email.inReplyTo,
    references: email.references,
    date: email.date,
  };

  // Single lookup instead of repeated .find() calls.
  const matchedAppointment = allActiveAppointments.find((a) => a.id === appointmentRequest.id);

  const appointmentContext: AppointmentContext = {
    id: appointmentRequest.id,
    userEmail: appointmentRequest.userEmail,
    therapistEmail: appointmentRequest.therapistEmail,
    therapistName: matchedAppointment?.therapistName || '',
    gmailThreadId: matchedAppointment?.gmailThreadId || null,
    therapistGmailThreadId: matchedAppointment?.therapistGmailThreadId || null,
    initialMessageId: matchedAppointment?.initialMessageId || null,
    status: matchedAppointment?.status || 'pending',
    createdAt: matchedAppointment?.createdAt || new Date(),
    therapistId: matchedAppointment?.therapistId ?? null,
    therapistHandle: matchedAppointment?.therapistHandle ?? null,
  };

  return checkAndHandleDivergence({
    appointmentId: appointmentRequest.id,
    email: emailContext,
    appointmentContext,
    allActiveAppointments: allActiveAppointments as AppointmentContext[],
    messageId,
    traceId,
  });
}
