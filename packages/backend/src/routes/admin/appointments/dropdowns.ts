/**
 * Dropdown population endpoints for the admin appointments page.
 *
 *   GET /api/admin/appointments/users
 *   GET /api/admin/appointments/therapists
 *
 * Both return the full list (capped at `DROPDOWN_LIMIT` for safety
 * against runaway dataset OOMs). The frontend filters client-side
 * because the dropdown UX needs the full list in memory; when we
 * hit the cap we log a warning so the truncation is visible
 * instead of silent — that's the signal to switch to a typeahead-
 * search endpoint.
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { prisma } from '../../../utils/database';
import { logger } from '../../../utils/logger';
import { sendSuccess, Errors } from '../../../utils/response';

// Safety cap. Set generously above any realistic workspace size.
const DROPDOWN_LIMIT = 5000;

export async function dropdownsRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get(
    '/api/admin/appointments/users',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = request.id;
      logger.info({ requestId }, 'Fetching users for admin appointment creation');

      try {
        const users = await prisma.user.findMany({
          select: {
            id: true,
            email: true,
            name: true,
            odId: true,
          },
          orderBy: { name: 'asc' },
          take: DROPDOWN_LIMIT,
        });

        if (users.length >= DROPDOWN_LIMIT) {
          logger.warn(
            { requestId, limit: DROPDOWN_LIMIT },
            'User dropdown hit the safety cap — admin sees a truncated list. Time to switch to a typeahead-search endpoint.',
          );
        }

        return sendSuccess(reply, users);
      } catch (err) {
        logger.error({ err, requestId }, 'Failed to fetch users');
        return Errors.internal(reply, 'Failed to fetch users');
      }
    },
  );

  fastify.get(
    '/api/admin/appointments/therapists',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = request.id;
      logger.info({ requestId }, 'Fetching therapists for admin appointment creation');

      try {
        const therapists = await prisma.therapist.findMany({
          select: {
            id: true,
            notionId: true,
            email: true,
            name: true,
            odId: true,
          },
          orderBy: { name: 'asc' },
          take: DROPDOWN_LIMIT,
        });

        if (therapists.length >= DROPDOWN_LIMIT) {
          logger.warn(
            { requestId, limit: DROPDOWN_LIMIT },
            'Therapist dropdown hit the safety cap — admin sees a truncated list. Time to switch to a typeahead-search endpoint.',
          );
        }

        return sendSuccess(reply, therapists);
      } catch (err) {
        logger.error({ err, requestId }, 'Failed to fetch therapists');
        return Errors.internal(reply, 'Failed to fetch therapists');
      }
    },
  );
}
