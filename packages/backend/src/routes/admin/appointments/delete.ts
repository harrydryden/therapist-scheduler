/**
 * DELETE /api/admin/dashboard/appointments/:id
 *
 * Hard delete an appointment request. Confirmed appointments require
 * `forceDeleteConfirmed: true` as a safety check — deleting a real
 * booking should be a deliberate operator decision.
 *
 * Cascading effects:
 *   - PendingEmail rows for this appointment are cascade-deleted
 *     by the FK.
 *   - Therapist booking status is recalculated (unique-request count
 *     drops; the "confirmed" flag is cleared if the row had been
 *     freezing the therapist).
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../../utils/database';
import { logger } from '../../../utils/logger';
import { therapistBookingStatusService } from '../../../services/therapist-booking-status.service';
import { RATE_LIMITS } from '../../../constants';
import { sendSuccess, Errors } from '../../../utils/response';

const deleteBodySchema = z.object({
  reason: z.string().optional(),
  adminId: z.string().min(1),
  forceDeleteConfirmed: z.boolean().optional(),
});

export async function deleteRoute(fastify: FastifyInstance): Promise<void> {
  fastify.delete<{ Params: { id: string } }>(
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

      const validation = deleteBodySchema.safeParse(request.body);
      if (!validation.success) {
        return Errors.validationFailed(reply, validation.error.errors);
      }

      const { reason, adminId, forceDeleteConfirmed } = validation.data;

      try {
        const appointment = await prisma.appointmentRequest.findUnique({
          where: { id },
          select: {
            id: true,
            status: true,
            userEmail: true,
            therapistEmail: true,
            therapistName: true,
            therapistHandle: true,
          },
        });

        if (!appointment) {
          return Errors.notFound(reply, 'Appointment');
        }

        // Don't allow deleting confirmed appointments unless force flag is set.
        if (appointment.status === 'confirmed' && !forceDeleteConfirmed) {
          return Errors.badRequest(
            reply,
            'Cannot delete confirmed appointments. Use forceDeleteConfirmed: true if the appointment did not actually take place.',
          );
        }

        const wasConfirmed = appointment.status === 'confirmed';

        // Delete the appointment (PendingEmails cascade-delete via FK).
        await prisma.appointmentRequest.delete({ where: { id } });

        // Recalculate therapist booking status. The previous Notion
        // freeze-mirror has been retired — the Postgres
        // TherapistBookingStatus row is authoritative.
        if (appointment.therapistHandle) {
          if (wasConfirmed) {
            await Promise.all([
              therapistBookingStatusService.recalculateUniqueRequestCount(appointment.therapistHandle),
              therapistBookingStatusService.unmarkConfirmed(appointment.therapistHandle),
            ]);
          } else {
            await therapistBookingStatusService.recalculateUniqueRequestCount(
              appointment.therapistHandle,
            );
          }
        }

        logger.info(
          {
            requestId,
            appointmentId: id,
            adminId,
            reason,
            userEmail: appointment.userEmail,
            therapistName: appointment.therapistName,
          },
          'Appointment deleted by admin',
        );

        return sendSuccess(reply, {
          id,
          message: 'Appointment deleted successfully',
        });
      } catch (err) {
        logger.error({ err, requestId, appointmentId: id }, 'Failed to delete appointment');
        return Errors.internal(reply, 'Failed to delete appointment');
      }
    },
  );
}
