/**
 * Admin SSE Route
 *
 * Provides a Server-Sent Events endpoint for real-time dashboard updates.
 * The browser's EventSource API doesn't support custom headers, so we
 * accept the webhook secret as a query parameter instead of a header.
 */
import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { safeCompare } from '../middleware/auth';
import { config } from '../config';
import { logger } from '../utils/logger';
import { sseService } from '../services/sse.service';

export async function adminSSERoutes(fastify: FastifyInstance) {
  /**
   * GET /api/admin/dashboard/events
   * SSE stream for real-time appointment updates.
   *
   * Auth: ?secret=<webhook_secret> (EventSource cannot send custom headers)
   */
  fastify.get(
    '/api/admin/dashboard/events',
    async (request: FastifyRequest<{ Querystring: { secret?: string } }>, reply: FastifyReply) => {
      const { secret } = request.query as { secret?: string };

      // Validate auth via query param
      const secretValid =
        typeof secret === 'string' &&
        config.webhookSecret &&
        safeCompare(secret, config.webhookSecret);

      if (!secretValid) {
        logger.warn({ requestId: request.id }, 'SSE connection rejected - invalid secret');
        return reply.status(401).send({ error: 'Unauthorized' });
      }

      const connectionId = sseService.addConnection(reply);
      if (!connectionId) {
        return; // Connection rejected (limit reached), response already sent
      }

      // Keep the connection open — Fastify won't auto-close because we wrote headers manually
      // The reply.raw 'close' event handler in sseService cleans up on disconnect
    }
  );
}
