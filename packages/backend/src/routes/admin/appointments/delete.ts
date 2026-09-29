/**
 * DELETE /api/admin/dashboard/appointments/:id
 *
 * Hard delete an appointment request.
 *
 * Post-booking rows (confirmed, session_held, feedback_requested,
 * completed) are real bookings: deleting one requires `force: true` AND a
 * non-empty `reason`. (`forceDeleteConfirmed: true` is still accepted as a
 * deprecated alias for `force` so the current dashboard keeps working; it
 * no longer means "confirmed only".) Pre-booking and cancelled rows can be
 * deleted without force.
 *
 * What a delete does NOT touch:
 *   - `therapist_completed_clients`. A therapist's graduation is a durable
 *     fact recorded when the session completed; deleting the appointment
 *     row (cleanup, erasure request, mistake) must not put a graduated
 *     therapist back on the public finder. The table has no FK to the
 *     appointment and stores only a hash of the client email.
 *
 * What a delete destroys (FK cascades): the appointment's audit events,
 * side-effect rows, pending emails and feedback links. Because the audit
 * trail goes with it, every delete leaves a tombstone OUTSIDE the database:
 * a structured `warn` log (`event: 'appointment_deleted'`) carrying the
 * appointment summary, plus a high-severity Slack alert. The tombstone
 * carries a hash of the client email, never the address — a delete is often
 * the answer to an erasure request.
 *
 * Therapist availability needs no recalculation: it is derived live from
 * appointment state and the completed-client table
 * (therapist-booking-status.service.ts).
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../../utils/database';
import { logger } from '../../../utils/logger';
import { firstName } from '../../../utils/first-name';
import { RATE_LIMITS, POST_BOOKING_STATUSES } from '../../../constants';
import { sendSuccess, Errors } from '../../../utils/response';
import { slackNotificationService } from '../../../services/slack-notification.service';
import { hashClientEmail } from '../../../domain/scheduling/lifecycle/completed-clients';

const deleteBodySchema = z.object({
  reason: z.string().optional(),
  adminId: z.string().min(1),
  force: z.boolean().optional(),
  /** @deprecated alias for `force` (the dashboard still sends it). */
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

      const { adminId } = validation.data;
      const reason = validation.data.reason?.trim() || undefined;
      const force = validation.data.force === true || validation.data.forceDeleteConfirmed === true;

      try {
        const appointment = await prisma.appointmentRequest.findUnique({
          where: { id },
          select: {
            id: true,
            status: true,
            userName: true,
            userEmail: true,
            therapistName: true,
            therapistHandle: true,
            therapistId: true,
            trackingCode: true,
            confirmedDateTime: true,
            confirmedAt: true,
            createdAt: true,
            transitionGeneration: true,
          },
        });

        if (!appointment) {
          return Errors.notFound(reply, 'Appointment');
        }

        const isPostBooking = (POST_BOOKING_STATUSES as readonly string[]).includes(appointment.status);
        if (isPostBooking && (!force || !reason)) {
          return Errors.badRequest(
            reply,
            `Cannot delete a ${appointment.status} appointment without force: true and a reason. ` +
              'It is a real booking and deleting it destroys its audit trail.',
          );
        }

        // Delete the appointment (audit events, side effects, pending
        // emails cascade via FK). Completed-client rows are untouched.
        await prisma.appointmentRequest.delete({ where: { id } });

        const tombstone = {
          appointmentId: appointment.id,
          status: appointment.status,
          trackingCode: appointment.trackingCode,
          therapistHandle: appointment.therapistHandle,
          therapistId: appointment.therapistId,
          therapistName: appointment.therapistName,
          clientEmailHash: hashClientEmail(appointment.userEmail),
          confirmedDateTime: appointment.confirmedDateTime,
          confirmedAt: appointment.confirmedAt?.toISOString() ?? null,
          createdAt: appointment.createdAt.toISOString(),
          transitionGeneration: appointment.transitionGeneration,
          deletedAt: new Date().toISOString(),
          deletedBy: adminId,
          forced: force,
          reason: reason ?? null,
        };

        // Tombstone: the audit table cascaded with the row, so this log line
        // is the durable record that the appointment existed.
        logger.warn({ requestId, event: 'appointment_deleted', tombstone }, 'Appointment deleted by admin (tombstone)');

        slackNotificationService
          .sendAlert({
            title: 'Appointment deleted by admin',
            severity: 'high',
            appointmentId: appointment.id,
            therapistName: appointment.therapistName,
            details:
              `An admin hard-deleted a *${appointment.status}* appointment. Its audit trail, ` +
              `side-effect log and pending emails were deleted with it; the tombstone is in the ` +
              `application log (event=appointment_deleted).` +
              (reason ? `\n\nReason: ${reason}` : ''),
            additionalFields: {
              Admin: adminId,
              Client: firstName(appointment.userName, '(unknown)'),
              'Tracking code': appointment.trackingCode ?? '(none)',
              Forced: force ? 'yes' : 'no',
            },
          })
          .catch((err) => {
            logger.warn({ err, requestId, appointmentId: id }, 'Failed to send appointment-deleted Slack alert');
          });

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
