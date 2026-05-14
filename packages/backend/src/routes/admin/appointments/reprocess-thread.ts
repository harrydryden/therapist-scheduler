/**
 * POST /api/admin/dashboard/appointments/:id/reprocess-thread
 *
 * Reprocess an appointment's Gmail threads to recover messages that
 * the inbound pipeline missed (or to re-run specific messages after
 * an agent fix).
 *
 * Three modes via request body:
 *   - Preview (`dryRun: true`): returns a per-thread message list
 *     showing which are processed vs unprocessed and any recorded
 *     processing errors. No state changes.
 *   - Safe (default): processes only messages that were never
 *     processed.
 *   - Force (`forceMessageIds: [...]`): clears specific message
 *     records first, then reprocesses. Useful when a known-bad
 *     processed-record needs to be replayed.
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { prisma } from '../../../utils/database';
import { logger } from '../../../utils/logger';
import { emailProcessingService } from '../../../services/email-processing.service';
import { sendSuccess, Errors } from '../../../utils/response';
import { isGmail404 } from '../../../utils/gmail-errors';

export async function reprocessThreadRoute(fastify: FastifyInstance): Promise<void> {
  fastify.post(
    '/api/admin/dashboard/appointments/:id/reprocess-thread',
    {
      config: {
        rateLimit: {
          max: 10,
          timeWindow: 60000,
        },
      },
    },
    async (
      request: FastifyRequest<{
        Params: { id: string };
        Body: { dryRun?: boolean; forceMessageIds?: string[] };
      }>,
      reply: FastifyReply,
    ) => {
      const requestId = request.id;
      const { id } = request.params;
      const body = (request.body || {}) as { dryRun?: boolean; forceMessageIds?: string[] };
      const { dryRun, forceMessageIds } = body;

      logger.info(
        { requestId, appointmentId: id, dryRun, forceMessageIds },
        dryRun ? 'Admin previewing thread reprocessing' : 'Admin triggered thread reprocessing',
      );

      try {
        const appointment = await prisma.appointmentRequest.findUnique({
          where: { id },
          select: {
            id: true,
            userName: true,
            therapistName: true,
            gmailThreadId: true,
            therapistGmailThreadId: true,
            status: true,
          },
        });

        if (!appointment) {
          return Errors.notFound(reply, 'Appointment');
        }

        if (!appointment.gmailThreadId && !appointment.therapistGmailThreadId) {
          return Errors.badRequest(reply, 'Appointment has no Gmail thread IDs to reprocess');
        }

        const traceId = `${requestId}:admin-reprocess:${id}`;

        // ─── DRY RUN ──────────────────────────────────────────────
        if (dryRun) {
          const preview: Array<{
            threadId: string;
            type: string;
            messages: Array<{
              messageId: string;
              from: string;
              subject: string;
              date: string;
              status: 'processed' | 'unprocessed';
              snippet: string;
              lastError?: string;
              processedContext?: string;
            }>;
          }> = [];

          if (appointment.therapistGmailThreadId) {
            const result = await emailProcessingService.previewThreadMessages(
              appointment.therapistGmailThreadId,
              traceId,
            );
            preview.push({
              threadId: appointment.therapistGmailThreadId,
              type: 'therapist',
              ...result,
            });
          }

          if (appointment.gmailThreadId) {
            const result = await emailProcessingService.previewThreadMessages(
              appointment.gmailThreadId,
              traceId,
            );
            preview.push({
              threadId: appointment.gmailThreadId,
              type: 'client',
              ...result,
            });
          }

          const allMessages = preview.flatMap((p) => p.messages);
          const unprocessedCount = allMessages.filter((m) => m.status === 'unprocessed').length;

          return sendSuccess(reply, {
            appointmentId: id,
            userName: appointment.userName,
            therapistName: appointment.therapistName,
            dryRun: true,
            threads: preview,
            totalMessages: allMessages.length,
            unprocessedCount,
            message: unprocessedCount > 0
              ? `Found ${unprocessedCount} unprocessed message(s) that can be recovered`
              : 'All messages in this thread have already been processed',
          });
        }

        // ─── REPROCESS (Safe or Force) ────────────────────────────
        const results: Array<{ threadId: string; type: string; cleared: number; reprocessed: number }> = [];

        if (appointment.therapistGmailThreadId) {
          const result = await emailProcessingService.reprocessThread(
            appointment.therapistGmailThreadId,
            traceId,
            forceMessageIds,
          );
          results.push({
            threadId: appointment.therapistGmailThreadId,
            type: 'therapist',
            ...result,
          });
        }

        if (appointment.gmailThreadId) {
          const result = await emailProcessingService.reprocessThread(
            appointment.gmailThreadId,
            traceId,
            forceMessageIds,
          );
          results.push({
            threadId: appointment.gmailThreadId,
            type: 'client',
            ...result,
          });
        }

        const totalCleared = results.reduce((sum, r) => sum + r.cleared, 0);
        const totalReprocessed = results.reduce((sum, r) => sum + r.reprocessed, 0);

        logger.info(
          { requestId, appointmentId: id, results, totalCleared, totalReprocessed },
          'Thread reprocessing complete',
        );

        return sendSuccess(reply, {
          appointmentId: id,
          userName: appointment.userName,
          therapistName: appointment.therapistName,
          threads: results,
          totalCleared,
          totalReprocessed,
          message: totalReprocessed > 0
            ? `Recovered ${totalReprocessed} message(s) from ${results.length} thread(s)`
            : totalCleared > 0
              ? `Cleared ${totalCleared} record(s) but no new messages found to process`
              : 'No unprocessed messages found in this thread',
        });
      } catch (err: unknown) {
        if (isGmail404(err)) {
          return Errors.notFound(reply, 'Gmail thread', 'it may have been deleted');
        }
        logger.error({ err, requestId, appointmentId: id }, 'Failed to reprocess thread');
        return Errors.internal(reply, 'Failed to reprocess thread');
      }
    },
  );
}
