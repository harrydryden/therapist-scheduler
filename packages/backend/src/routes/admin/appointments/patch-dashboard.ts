/**
 * PATCH /api/admin/dashboard/appointments/:id
 *
 * Update an appointment's status and/or confirmedDateTime from the
 * admin dashboard's detail drawer. Requires `humanControlEnabled` —
 * the admin must have taken control of the conversation before
 * editing it (prevents the agent and admin from concurrently writing
 * conflicting state).
 *
 * Status changes route through `appointmentLifecycleService.updateStatus`
 * for atomic FSM validation + side effects. Date-only edits (without
 * a status change) route through `adminForceUpdate` for consistent
 * rescheduling-flag + audit handling.
 *
 * Distinct from the appointments-page PATCH (in `patch-admin.ts`),
 * which does NOT require human control and is the canonical
 * "fix-up by an admin" path.
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { prisma } from '../../../utils/database';
import { logger } from '../../../utils/logger';
import {
  appointmentLifecycleService,
  InvalidTransitionError,
  ConcurrentModificationError,
} from '../../../domain/scheduling/lifecycle';
import { parseConfirmedDateTime } from '../../../utils/date';
import { AppointmentStatus, RATE_LIMITS } from '../../../constants';
import { sendSuccess, sendError, Errors } from '../../../utils/response';
import { updateAppointmentSchema } from './schemas';

export async function patchDashboardRoute(fastify: FastifyInstance): Promise<void> {
  fastify.patch<{ Params: { id: string } }>(
    '/api/admin/dashboard/appointments/:id',
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

      const validation = updateAppointmentSchema.safeParse(request.body);
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
            humanControlEnabled: true,
          },
        });

        if (!appointment) {
          return Errors.notFound(reply, 'Appointment');
        }

        if (!appointment.humanControlEnabled) {
          return Errors.badRequest(
            reply,
            'Human control must be enabled before editing appointment. Take control first.',
          );
        }

        // Validate: if setting status to confirmed, confirmedDateTime is required.
        const effectiveConfirmedDateTime = confirmedDateTime ?? appointment.confirmedDateTime;
        if (newStatus === 'confirmed' && !effectiveConfirmedDateTime) {
          return Errors.badRequest(reply, 'confirmedDateTime is required when setting status to confirmed');
        }

        // Require reason whenever the request would mutate state.
        // Matches the strictness of /api/admin/appointments/:id so the
        // audit trail is consistent. A no-op call doesn't need a reason.
        const statusChanging = !!newStatus && newStatus !== appointment.status;
        const dateChanging = confirmedDateTime !== undefined && confirmedDateTime !== appointment.confirmedDateTime;
        const reasonProvided = !!reason && reason.trim().length > 0;
        if ((statusChanging || dateChanging) && !reasonProvided) {
          return Errors.badRequest(reply, 'reason is required when editing an appointment');
        }

        // Check for unusual transitions and generate warnings.
        let warning: string | undefined;
        const previousStatus = appointment.status;
        const wasConfirmed = previousStatus === 'confirmed';
        const wasCancelled = previousStatus === 'cancelled';

        if (newStatus && newStatus !== previousStatus) {
          if (wasConfirmed && newStatus !== 'cancelled') {
            warning = `Changed from confirmed to ${newStatus}. This may require manual cleanup.`;
          } else if (wasCancelled && newStatus !== 'cancelled') {
            warning = `Restored cancelled appointment to ${newStatus}. Verify this is intentional.`;
          }
        }

        let confirmedDateTimeParsed: Date | null = null;
        if (confirmedDateTime) {
          confirmedDateTimeParsed = parseConfirmedDateTime(confirmedDateTime);
          if (confirmedDateTimeParsed) {
            logger.debug({ requestId, appointmentId: id, confirmedDateTime, confirmedDateTimeParsed }, 'Parsed confirmedDateTime for manual update');
          } else {
            logger.warn({ requestId, appointmentId: id, confirmedDateTime }, 'Could not parse confirmedDateTime for manual update');
          }
        }

        // Use the centralized lifecycle service for status updates.
        if (newStatus && newStatus !== previousStatus) {
          const result = await appointmentLifecycleService.updateStatus(
            id,
            newStatus as AppointmentStatus,
            {
              source: 'admin',
              adminId,
              reason,
              confirmedDateTime: effectiveConfirmedDateTime || undefined,
              confirmedDateTimeParsed,
              sendEmails: true,
            },
          );

          if (result.skipped) {
            logger.debug({ requestId, appointmentId: id, newStatus }, 'Status transition skipped (idempotent)');
          }
        } else if (confirmedDateTime !== undefined && confirmedDateTime !== appointment.confirmedDateTime) {
          // Only confirmedDateTime changed, not status — use adminForceUpdate
          // for consistency (handles rescheduling flags, audit trail, SSE
          // notifications). Reason is guaranteed non-empty by the pre-
          // flight check above.
          await appointmentLifecycleService.adminForceUpdate(id, {
            confirmedDateTime,
            confirmedDateTimeParsed,
            adminId,
            bypassStateMachine: true,
            reason: reason!,
          });
        }

        const updated = await prisma.appointmentRequest.findUnique({
          where: { id },
          select: {
            id: true,
            status: true,
            confirmedDateTime: true,
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
          'Appointment updated by admin via lifecycle service',
        );

        return sendSuccess(reply, {
          id: updated?.id,
          status: updated?.status,
          confirmedDateTime: updated?.confirmedDateTime,
          confirmedAt: updated?.confirmedAt,
          updatedAt: updated?.updatedAt,
          previousStatus,
          warning,
        });
      } catch (err) {
        // Surface lifecycle validation errors as 400 (bad request) with
        // descriptive messages.
        if (err instanceof InvalidTransitionError) {
          logger.warn({ err, requestId, appointmentId: id }, 'Invalid status transition requested');
          return Errors.badRequest(reply, err.message);
        }
        if (err instanceof ConcurrentModificationError) {
          logger.warn({ err, requestId, appointmentId: id }, 'Concurrent modification detected');
          return sendError(reply, 409, err.message);
        }
        logger.error({ err, requestId, appointmentId: id }, 'Failed to update appointment');
        return Errors.internal(reply, 'Failed to update appointment');
      }
    },
  );
}
