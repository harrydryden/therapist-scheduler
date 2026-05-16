/**
 * GET /api/admin/dashboard/appointments
 *
 * List appointment requests with filtering, pagination, health-meta
 * decoration, and per-row last-message preview. Powers the admin
 * dashboard's main pipeline view.
 *
 * Reads denormalized columns (`messageCount`, `checkpointStage`)
 * instead of parsing the full 500KB `conversationState` blob (FIX
 * #21). The last-message preview is pulled via a Postgres JSONB
 * path expression so we don't have to load the blob just to render
 * the right-hand snippet column.
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { Prisma } from '@prisma/client';
import { prisma } from '../../../utils/database';
import { logger } from '../../../utils/logger';
import { ConversationStage, STAGE_COMPLETION_PERCENTAGE } from '../../../services/conversation-checkpoint.service';
import {
  toAppointmentForHealth,
  computeAppointmentHealthMeta,
  getHealthThresholds,
} from '../../../services/conversation-health.service';
import { sendSuccess, Errors } from '../../../utils/response';
import { buildLastMessagePreview, listAppointmentsSchema } from './schemas';
import { deriveNextAction } from '../../../utils/next-action';

export async function dashboardListRoute(fastify: FastifyInstance): Promise<void> {
  fastify.get(
    '/api/admin/dashboard/appointments',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = request.id;
      logger.info({ requestId }, 'Fetching appointment list for dashboard');

      const validation = listAppointmentsSchema.safeParse(request.query);
      if (!validation.success) {
        return Errors.badRequest(reply, 'Invalid query params', validation.error.errors);
      }

      const { status, therapistId, dateFrom, dateTo, page, limit, sortBy, sortOrder } =
        validation.data;

      const where: Record<string, unknown> = {};
      if (status && status !== 'all') {
        where.status = status;
      }
      if (therapistId) {
        where.therapistHandle = therapistId;
      }
      if (dateFrom || dateTo) {
        where.createdAt = {};
        if (dateFrom) {
          const d = new Date(dateFrom);
          if (isNaN(d.getTime())) return Errors.badRequest(reply, 'Invalid dateFrom format');
          (where.createdAt as Record<string, Date>).gte = d;
        }
        if (dateTo) {
          const d = new Date(dateTo);
          if (isNaN(d.getTime())) return Errors.badRequest(reply, 'Invalid dateTo format');
          (where.createdAt as Record<string, Date>).lte = d;
        }
      }

      try {
        const [appointments, total] = await Promise.all([
          prisma.appointmentRequest.findMany({
            where,
            orderBy: { [sortBy]: sortOrder },
            skip: (page - 1) * limit,
            take: limit,
            select: {
              id: true,
              trackingCode: true,
              userName: true,
              userEmail: true,
              therapistName: true,
              therapistEmail: true,
              therapistHandle: true,
              status: true,
              confirmedAt: true,
              confirmedDateTime: true,
              confirmedDateTimeParsed: true,
              notes: true,
              messageCount: true,
              checkpointStage: true,
              createdAt: true,
              updatedAt: true,
              humanControlEnabled: true,
              humanControlTakenBy: true,
              lastActivityAt: true,
              isStale: true,
              lastToolExecutedAt: true,
              lastToolExecutionFailed: true,
              lastToolFailureReason: true,
              threadDivergedAt: true,
              threadDivergenceDetails: true,
              threadDivergenceAcknowledged: true,
              conversationStallAlertAt: true,
              conversationStallAcknowledged: true,
              chaseSentAt: true,
              chaseSentTo: true,
              closureRecommendedAt: true,
              closureRecommendedReason: true,
              closureRecommendationActioned: true,
              reschedulingInProgress: true,
            },
          }),
          prisma.appointmentRequest.count({ where }),
        ]);

        // Last-message preview + last-email-recipient + pendingAction
        // per appointment via JSONB path expressions — capped at 240
        // chars at the DB layer so we never load the full blob.
        //
        // `lastEmailSentTo` is the recipient ('user' / 'therapist') of
        // the most recent agent-sent email, surfaced from
        // `conversation_state.checkpoint.context.lastEmailSentTo`.
        // Drives the dashboard's "Next action" wording — without it the
        // fallback is the unhelpfully-generic "Awaiting next message".
        //
        // `pendingAction` is the agent's escape-hatch override for
        // sub-states the canonical stage labels don't cover (e.g.
        // "Request more availability from therapist" when the first
        // round of slots didn't work). The detail panel surfaces it via
        // `buildAppointmentSummary`; the dashboard row must too,
        // otherwise the same row reads as one thing in the list and
        // another in detail — exactly the drift `deriveNextAction` is
        // there to prevent.
        //
        // The CASE on `jsonb_typeof` is the reason the query is the
        // shape it is. See PR #245 for the writes-stored-as-JSON-string
        // bug — same unwrap trick used here so legacy and current rows
        // both resolve.
        const lastMessages = appointments.length > 0
          ? await prisma.$queryRaw<Array<{ id: string; role: string | null; content: string | null; last_email_sent_to: string | null; pending_action: string | null }>>`
              SELECT id,
                     CASE jsonb_typeof(conversation_state)
                       WHEN 'object' THEN conversation_state->'messages'->-1->>'role'
                       WHEN 'string' THEN ((conversation_state #>> '{}')::jsonb)->'messages'->-1->>'role'
                     END AS role,
                     CASE jsonb_typeof(conversation_state)
                       WHEN 'object' THEN LEFT(conversation_state->'messages'->-1->>'content', 240)
                       WHEN 'string' THEN LEFT(((conversation_state #>> '{}')::jsonb)->'messages'->-1->>'content', 240)
                     END AS content,
                     CASE jsonb_typeof(conversation_state)
                       WHEN 'object' THEN conversation_state->'checkpoint'->'context'->>'lastEmailSentTo'
                       WHEN 'string' THEN ((conversation_state #>> '{}')::jsonb)->'checkpoint'->'context'->>'lastEmailSentTo'
                     END AS last_email_sent_to,
                     CASE jsonb_typeof(conversation_state)
                       WHEN 'object' THEN conversation_state->'checkpoint'->>'pendingAction'
                       WHEN 'string' THEN ((conversation_state #>> '{}')::jsonb)->'checkpoint'->>'pendingAction'
                     END AS pending_action
              FROM appointment_requests
              WHERE id IN (${Prisma.join(appointments.map((a) => a.id))})
            `
          : [];
        const lastMessageById = new Map(
          lastMessages.map((m) => [
            m.id,
            {
              role: m.role,
              content: m.content,
              lastEmailSentTo: m.last_email_sent_to,
              pendingAction: m.pending_action,
            },
          ]),
        );

        const healthThresholds = await getHealthThresholds();
        const appointmentsWithMeta = appointments.map((apt) => {
          const checkpointStage = (apt.checkpointStage as ConversationStage) || null;
          const checkpointProgress = checkpointStage
            ? (STAGE_COMPLETION_PERCENTAGE[checkpointStage] || 0)
            : 0;

          const healthMeta = computeAppointmentHealthMeta(toAppointmentForHealth(apt), healthThresholds);

          // Single Map lookup, derive both the preview shape and the
          // raw-vs-normalised role + lastEmailSentTo signals from it.
          // Previously did 4 separate `lastMessageById.get(apt.id)`
          // calls per row — and also passed the RAW `'assistant'` role
          // to `deriveNextAction` whose branches check for the
          // normalised `'agent'` value, silently disabling the
          // "Awaiting reply" fallback.
          const lastMessageData = lastMessageById.get(apt.id);
          const lastMessagePreview = buildLastMessagePreview(lastMessageData);
          const lastEmailSentTo: 'user' | 'therapist' | null =
            lastMessageData?.lastEmailSentTo === 'user'
              ? 'user'
              : lastMessageData?.lastEmailSentTo === 'therapist'
                ? 'therapist'
                : null;

          return {
            id: apt.id,
            userName: apt.userName,
            userEmail: apt.userEmail,
            therapistName: apt.therapistName,
            therapistEmail: apt.therapistEmail,
            therapistHandle: apt.therapistHandle,
            status: apt.status,
            messageCount: apt.messageCount,
            confirmedAt: apt.confirmedAt,
            confirmedDateTime: apt.confirmedDateTime,
            confirmedDateTimeParsed: apt.confirmedDateTimeParsed,
            notes: apt.notes,
            createdAt: apt.createdAt,
            updatedAt: apt.updatedAt,
            humanControlEnabled: apt.humanControlEnabled,
            humanControlTakenBy: apt.humanControlTakenBy,
            lastActivityAt: apt.lastActivityAt,
            isStale: apt.isStale,
            checkpointStage,
            checkpointProgress,
            ...healthMeta,
            chaseSentAt: apt.chaseSentAt,
            chaseSentTo: apt.chaseSentTo,
            closureRecommendedAt: apt.closureRecommendedAt,
            closureRecommendedReason: apt.closureRecommendedReason,
            closureRecommendationActioned: apt.closureRecommendationActioned,
            reschedulingInProgress: apt.reschedulingInProgress,
            lastMessagePreview,
            nextAction: deriveNextAction({
              status: apt.status,
              humanControlEnabled: apt.humanControlEnabled,
              chaseSentAt: apt.chaseSentAt,
              chaseSentTo: apt.chaseSentTo,
              closureRecommendedAt: apt.closureRecommendedAt,
              closureRecommendationActioned: apt.closureRecommendationActioned,
              confirmedDateTime: apt.confirmedDateTime,
              checkpointStage,
              // Must mirror `buildAppointmentSummary`'s
              // pendingAction pass-through so list and detail views
              // never disagree on the row's next-action label.
              pendingAction: lastMessageData?.pendingAction ?? null,
              lastEmailSentTo,
              // The NORMALISED role — `buildLastMessagePreview` maps
              // `'assistant' → 'agent'` and unknown roles to
              // `'inbound'`. `deriveNextAction`'s branches check
              // exactly those values, so passing the raw `apt.role`
              // string here would silently disable them.
              lastMessageRole: lastMessagePreview?.role ?? null,
            }),
          };
        });

        return sendSuccess(reply, appointmentsWithMeta, {
          pagination: {
            page,
            limit,
            total,
            totalPages: Math.ceil(total / limit),
          },
        });
      } catch (err) {
        logger.error({ err, requestId }, 'Failed to fetch appointments');
        return Errors.internal(reply, 'Failed to fetch appointments');
      }
    },
  );
}
