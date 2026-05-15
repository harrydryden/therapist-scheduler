/**
 * Human-control endpoints:
 *
 *   POST /api/admin/dashboard/appointments/:id/take-control
 *   POST /api/admin/dashboard/appointments/:id/release-control
 *   GET  /api/admin/dashboard/ceiling-tripped-count
 *   POST /api/admin/dashboard/release-ceiling-tripped
 *
 * The ceiling endpoints belong here because they're a bulk version
 * of release-control — they target the subset of appointments that
 * tripped the per-appointment tool-call ceiling defence and have
 * been auto-flagged for human review.
 *
 * Take-control is the atomic claim primitive: `updateMany` with
 * `humanControlEnabled: false` as a precondition. Two admins
 * clicking simultaneously can no longer both pass a check-then-write;
 * one wins, the other gets the resolve-by-state branch.
 *
 * Release-control writes the audit append via the optimistic-locked
 * `appendConversationMessage` helper so a concurrent agent save /
 * chase-tick can't silently overwrite it. The DB flag flip still
 * proceeds if the append fails twice — losing an audit entry is
 * preferable to leaving the appointment stuck in human-control state.
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { prisma } from '../../../utils/database';
import { logger } from '../../../utils/logger';
import { aiConversationService } from '../../../services/ai-conversation.service';
import { auditEventService } from '../../../services/audit-event.service';
import { sseService } from '../../../services/sse.service';
import { resetAppointmentToolCount } from '../../../services/appointment-tool-counter';
import { emailProcessingService } from '../../../services/email-processing.service';
import { runBackgroundTask } from '../../../utils/background-task';
import { RATE_LIMITS } from '../../../constants';
import { sendSuccess, sendError, Errors } from '../../../utils/response';
import { CEILING_TRIPPED_WHERE, takeControlSchema } from './schemas';

/**
 * Replay any inbound messages that arrived while human control was
 * on (logged in conversation state but not marked processed —
 * `'logged-while-paused'` semantics, see process.ts STEP 16).
 *
 * Scans the appointment's Gmail threads and triggers the missed-
 * message recovery path. Runs in the background — the release
 * endpoints don't block on it, so the operator gets an immediate
 * 200 OK and the replay happens asynchronously.
 *
 * The hourly missed-message-scanner would eventually pick these
 * up too; this inline call just trims the latency from up-to-1h
 * down to seconds.
 */
function replayPausedMessages(
  appointmentId: string,
  threadIds: string[],
  requestId: string,
): void {
  for (const threadId of threadIds) {
    runBackgroundTask(
      () => emailProcessingService.checkThreadForUnprocessedReplies(
        threadId,
        `release-replay:${appointmentId}`,
      ),
      {
        name: 'replay-paused-messages',
        context: { requestId, appointmentId, threadId },
        retry: false,
      },
    );
  }
}

export async function humanControlRoutes(fastify: FastifyInstance): Promise<void> {
  // ─── take-control ────────────────────────────────────────────────
  fastify.post<{ Params: { id: string } }>(
    '/api/admin/dashboard/appointments/:id/take-control',
    {
      config: {
        rateLimit: {
          max: RATE_LIMITS.ADMIN_MUTATIONS.max,
          timeWindow: RATE_LIMITS.ADMIN_MUTATIONS.timeWindowMs,
        },
      },
    },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const { id } = request.params;
      const requestId = request.id;

      const validation = takeControlSchema.safeParse(request.body);
      if (!validation.success) {
        return Errors.validationFailed(reply, validation.error.errors);
      }

      const { adminId, reason } = validation.data;

      try {
        // Atomic claim: only flip the flag when no one currently
        // holds control. Two admins clicking simultaneously can no
        // longer both pass a check-then-write — exactly one
        // updateMany returns count=1.
        const takenAt = new Date();
        const claim = await prisma.appointmentRequest.updateMany({
          where: { id, humanControlEnabled: false },
          data: {
            humanControlEnabled: true,
            humanControlTakenBy: adminId,
            humanControlTakenAt: takenAt,
            humanControlReason: reason || null,
          },
        });

        if (claim.count === 0) {
          // Either the row doesn't exist or someone else already
          // holds control. Re-fetch to distinguish.
          const current = await prisma.appointmentRequest.findUnique({
            where: { id },
            select: { humanControlEnabled: true, humanControlTakenBy: true },
          });

          if (!current) {
            return Errors.notFound(reply, 'Appointment');
          }

          if (current.humanControlEnabled && current.humanControlTakenBy === adminId) {
            // Idempotent: caller already holds control (e.g. retry).
            return sendSuccess(reply, {
              id,
              humanControlEnabled: true,
              humanControlTakenBy: adminId,
              message: 'You already have control of this appointment',
            });
          }

          // Different admin won the race.
          return sendError(
            reply,
            409,
            `This appointment is already being handled by ${current.humanControlTakenBy}`,
          );
        }

        logger.info(
          { requestId, appointmentId: id, adminId, reason },
          'Human control enabled for appointment',
        );

        auditEventService.log(id, 'human_control', 'admin', {
          enabled: true,
          adminEmail: adminId,
          reason: reason || 'Manual admin takeover',
        });

        sseService.emitHumanControl(id, true, adminId);

        return sendSuccess(reply, {
          id,
          humanControlEnabled: true,
          humanControlTakenBy: adminId,
          humanControlTakenAt: takenAt,
        });
      } catch (err) {
        logger.error({ err, requestId, appointmentId: id }, 'Failed to enable human control');
        return Errors.internal(reply, 'Failed to enable human control');
      }
    },
  );

  // ─── release-control ─────────────────────────────────────────────
  fastify.post<{ Params: { id: string } }>(
    '/api/admin/dashboard/appointments/:id/release-control',
    {
      config: {
        rateLimit: {
          max: RATE_LIMITS.ADMIN_MUTATIONS.max,
          timeWindow: RATE_LIMITS.ADMIN_MUTATIONS.timeWindowMs,
        },
      },
    },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const { id } = request.params;
      const requestId = request.id;

      try {
        // Append a system note via the optimistic-locked helper so a
        // concurrent agent save / chase-tick can't silently overwrite
        // this audit entry. If the helper fails (twice), the disable
        // below still proceeds — losing the audit entry is preferable
        // to leaving the appointment stuck in human-control state.
        await aiConversationService
          .appendConversationMessage(id, {
            role: 'admin',
            content: '[System] Human control released. Agent resuming automated responses.',
          })
          .catch((err) => {
            logger.error(
              { err, requestId, appointmentId: id },
              'Release-control audit append failed twice — manual reconciliation may be needed',
            );
          });

        const appointment = await prisma.appointmentRequest.update({
          where: { id },
          data: {
            humanControlEnabled: false,
            // Keep history: don't clear humanControlTakenBy/At so the
            // audit trail of who took over and when remains intact.
            // Re-arm stall detection / auto-escalation so a resolved-
            // then-restalled conversation can escalate again. Without
            // this, autoEscalatedAt stays pinned forever and the
            // stale-check refuses to escalate the second incident.
            autoEscalatedAt: null,
            conversationStallAlertAt: null,
            conversationStallAcknowledged: false,
          },
          select: {
            id: true,
            gmailThreadId: true,
            therapistGmailThreadId: true,
          },
        });

        logger.info({ requestId, appointmentId: id }, 'Human control released for appointment');

        sseService.emitHumanControl(id, false);

        // Replay any messages that arrived while paused. See the
        // `replayPausedMessages` helper for the rationale.
        const threadIds = [appointment.gmailThreadId, appointment.therapistGmailThreadId]
          .filter((t): t is string => typeof t === 'string' && t.length > 0);
        if (threadIds.length > 0) {
          replayPausedMessages(id, threadIds, requestId);
        }

        return sendSuccess(reply, {
          id: appointment.id,
          humanControlEnabled: false,
        });
      } catch (err) {
        logger.error({ err, requestId, appointmentId: id }, 'Failed to release human control');
        return Errors.internal(reply, 'Failed to release human control');
      }
    },
  );

  // ─── ceiling-tripped count ───────────────────────────────────────
  // The per-appointment tool-call ceiling is a defence-in-depth
  // control that has historically produced false positives on long,
  // legitimate conversations. This count surfaces on the dashboard.
  fastify.get(
    '/api/admin/dashboard/ceiling-tripped-count',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = request.id;
      try {
        const count = await prisma.appointmentRequest.count({ where: CEILING_TRIPPED_WHERE });
        return sendSuccess(reply, { count });
      } catch (err) {
        logger.error({ err, requestId }, 'Failed to count ceiling-tripped appointments');
        return Errors.internal(reply, 'Failed to count ceiling-tripped appointments');
      }
    },
  );

  // ─── bulk-release ceiling-tripped ────────────────────────────────
  // Unpauses every ceiling-tripped appointment in one operator action,
  // resets each appointment's Redis tool-count key (otherwise the
  // next inbound call re-trips the ceiling on the same counter), and
  // re-arms stall detection.
  //
  // Filter is deliberately narrow: only `humanControlReason` matching
  // 'Tool execution ceiling reached'. Other agent-flag reasons
  // (genuine uncertainty, the loop-level breakers) are still routed
  // through the per-appointment release-control endpoint so an admin
  // can triage each one.
  fastify.post(
    '/api/admin/dashboard/release-ceiling-tripped',
    {
      config: {
        rateLimit: {
          max: RATE_LIMITS.ADMIN_MUTATIONS.max,
          timeWindow: RATE_LIMITS.ADMIN_MUTATIONS.timeWindowMs,
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = request.id;
      try {
        const candidates = await prisma.appointmentRequest.findMany({
          where: CEILING_TRIPPED_WHERE,
          select: {
            id: true,
            gmailThreadId: true,
            therapistGmailThreadId: true,
          },
        });

        const released: string[] = [];
        const failed: Array<{ id: string; reason: string }> = [];

        for (const { id, gmailThreadId, therapistGmailThreadId } of candidates) {
          try {
            // Best-effort audit append — same pattern as release-control.
            await aiConversationService
              .appendConversationMessage(id, {
                role: 'admin',
                content: '[System] Human control released via bulk ceiling-tripped release. Agent resuming automated responses.',
              })
              .catch((err) => {
                logger.error(
                  { err, requestId, appointmentId: id },
                  'Bulk-release audit append failed — continuing with DB update',
                );
              });

            await prisma.appointmentRequest.update({
              where: { id },
              data: {
                humanControlEnabled: false,
                autoEscalatedAt: null,
                conversationStallAlertAt: null,
                conversationStallAcknowledged: false,
              },
              select: { id: true },
            });

            // Reset the Redis tool-count key — without this, the next
            // tool call on this appointment increments past the ceiling
            // again and re-trips immediately.
            await resetAppointmentToolCount(id);

            sseService.emitHumanControl(id, false);
            released.push(id);

            // Replay any messages that arrived while the ceiling
            // was tripped. Without this, paused replies (logged but
            // not marked processed — see process.ts STEP 16) wait
            // up to an hour for the missed-message-scanner. Operators
            // doing bulk-release expect the agent to resume *now*.
            const threadIds = [gmailThreadId, therapistGmailThreadId]
              .filter((t): t is string => typeof t === 'string' && t.length > 0);
            if (threadIds.length > 0) {
              replayPausedMessages(id, threadIds, requestId);
            }
          } catch (err) {
            logger.error(
              { err, requestId, appointmentId: id },
              'Failed to release individual ceiling-tripped appointment',
            );
            failed.push({ id, reason: err instanceof Error ? err.message : 'Unknown error' });
          }
        }

        logger.info(
          { requestId, releasedCount: released.length, failedCount: failed.length },
          'Bulk-release of ceiling-tripped appointments complete',
        );

        return sendSuccess(reply, { released, failed });
      } catch (err) {
        logger.error({ err, requestId }, 'Failed to bulk-release ceiling-tripped appointments');
        return Errors.internal(reply, 'Failed to bulk-release ceiling-tripped appointments');
      }
    },
  );
}
