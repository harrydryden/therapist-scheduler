/**
 * PATCH /api/admin/appointments/:id
 *
 * Update an appointment's status and/or confirmedDateTime from the
 * admin appointments management page. Unlike the dashboard PATCH,
 * this does NOT require human control — it's the canonical
 * "fix-up by an admin" path that's allowed to operate while the
 * agent is also active on the conversation.
 *
 * Routes through `appointmentLifecycleService.adminForceUpdate`
 * which bypasses state-machine validation but still records the
 * audit trail, emits SSE notifications, and (for status changes)
 * sends a high-severity Slack alert so the bypass is visible.
 *
 * `bypassStateMachine: true` + non-empty `reason` are required.
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { prisma } from '../../../utils/database';
import { logger } from '../../../utils/logger';
import { appointmentLifecycleService } from '../../../domain/scheduling/lifecycle';
import { parseConfirmedDateTime } from '../../../utils/date';
import { AppointmentStatus, RATE_LIMITS } from '../../../constants';
import { sendSuccess, Errors } from '../../../utils/response';
import { adminUpdateSchema } from './schemas';

export async function patchAdminRoute(fastify: FastifyInstance): Promise<void> {
  fastify.patch<{ Params: { id: string } }>(
    '/api/admin/appointments/:id',
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

      const validation = adminUpdateSchema.safeParse(request.body);
      if (!validation.success) {
        return Errors.validationFailed(reply, validation.error.errors);
      }

      const { status: newStatus, confirmedDateTime, adminId, reason } = validation.data;

      try {
        const appointment = await prisma.appointmentRequest.findUnique({
          where: { id },
          select: {
            id: true,
            status: true,
            confirmedDateTime: true,
          },
        });

        if (!appointment) {
          return Errors.notFound(reply, 'Appointment');
        }

        // Validate: if setting status to confirmed, confirmedDateTime is required.
        const effectiveConfirmedDateTime = confirmedDateTime ?? appointment.confirmedDateTime;
        if (newStatus === 'confirmed' && !effectiveConfirmedDateTime) {
          return Errors.badRequest(reply, 'confirmedDateTime is required when setting status to confirmed');
        }

        const previousStatus = appointment.status;
        let warning: string | undefined;

        if (newStatus && newStatus !== previousStatus) {
          if (previousStatus === 'cancelled' && newStatus !== 'cancelled') {
            warning = `Restored cancelled appointment to ${newStatus}. Verify this is intentional.`;
          }
        }

        // Parse confirmedDateTime: first try as ISO string (from
        // datetime-local input), then fall back to natural language.
        let confirmedDateTimeParsed: Date | null = null;
        if (confirmedDateTime) {
          const isoDate = new Date(confirmedDateTime);
          if (!isNaN(isoDate.getTime())) {
            confirmedDateTimeParsed = isoDate;
          } else {
            confirmedDateTimeParsed = parseConfirmedDateTime(confirmedDateTime);
          }
        }

        // Use lifecycle service's force update — bypasses state machine
        // validation but still records audit trail, emits SSE
        // notifications, and (for status changes) sends a high-severity
        // Slack alert so the bypass is visible. bypassStateMachine +
        // reason are required by the lifecycle method.
        if (!reason || reason.trim().length === 0) {
          return Errors.badRequest(reply, 'reason is required when force-updating an appointment');
        }
        await appointmentLifecycleService.adminForceUpdate(id, {
          newStatus: newStatus as AppointmentStatus | undefined,
          confirmedDateTime,
          confirmedDateTimeParsed,
          adminId,
          bypassStateMachine: true,
          reason,
        });

        const updated = await prisma.appointmentRequest.findUnique({
          where: { id },
          select: {
            id: true,
            status: true,
            confirmedDateTime: true,
            confirmedDateTimeParsed: true,
            confirmedAt: true,
            updatedAt: true,
          },
        });

        logger.info(
          {
            requestId,
            appointmentId: id,
            adminId,
            previousStatus,
            newStatus: updated?.status,
            confirmedDateTime: updated?.confirmedDateTime,
            reason,
          },
          'Appointment updated by admin from appointments page',
        );

        return sendSuccess(reply, {
          id: updated?.id,
          status: updated?.status,
          confirmedDateTime: updated?.confirmedDateTime,
          confirmedDateTimeParsed: updated?.confirmedDateTimeParsed,
          confirmedAt: updated?.confirmedAt,
          updatedAt: updated?.updatedAt,
          previousStatus,
          warning,
        });
      } catch (err) {
        logger.error({ err, requestId, appointmentId: id }, 'Failed to update appointment from admin page');
        const message = err instanceof Error ? err.message : 'Unknown error';
        return Errors.internal(reply, `Failed to update appointment: ${message}`);
      }
    },
  );
}
