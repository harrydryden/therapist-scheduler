/**
 * Unsubscribe Routes
 *
 * Public endpoints for email unsubscription.
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { logger } from '../utils/logger';
import { notionUsersService } from '../services/notion-users.service';
import { extractEmailFromToken } from '../utils/unsubscribe-token';

export async function unsubscribeRoutes(fastify: FastifyInstance) {
  /**
   * GET /api/unsubscribe/:token
   * Public endpoint for email unsubscription
   */
  fastify.get<{ Params: { token: string } }>(
    '/api/unsubscribe/:token',
    {
      config: {
        rateLimit: {
          max: 10,
          timeWindow: 60000, // 10 requests per minute per IP
        },
      },
    },
    async (request: FastifyRequest<{ Params: { token: string } }>, reply: FastifyReply) => {
      const { token } = request.params;
      const requestId = request.id;

      logger.info({ requestId }, 'Processing unsubscribe request');

      // Verify and decode token
      const email = extractEmailFromToken(token);
      if (!email) {
        // FIX L1: Remove token length from logs to prevent information disclosure
        logger.warn({ requestId }, 'Invalid unsubscribe token');
        return reply.status(400).type('text/html').send(`
          <!DOCTYPE html>
          <html>
          <head>
            <title>Invalid Link</title>
            <style>
              body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; padding: 40px; text-align: center; max-width: 600px; margin: 0 auto; }
              h1 { color: #e53e3e; }
              p { color: #4a5568; line-height: 1.6; }
              a { color: #3182ce; }
            </style>
          </head>
          <body>
            <h1>Invalid Link</h1>
            <p>This unsubscribe link is invalid or has expired.</p>
            <p>If you're having trouble unsubscribing, please contact us directly.</p>
          </body>
          </html>
        `);
      }

      try {
        // Find user in Notion
        const user = await notionUsersService.findUserByEmail(email);

        if (!user) {
          // User doesn't exist in Notion - still return success (idempotent)
          logger.warn({ requestId, email }, 'Unsubscribe for non-existent user');
          return returnSuccessPage(reply);
        }

        // Check if already unsubscribed
        if (!user.subscribed) {
          logger.info({ requestId, email }, 'User already unsubscribed');
          return returnSuccessPage(reply);
        }

        // Update subscription status
        await notionUsersService.updateSubscription(user.pageId, false);

        logger.info({ requestId, email }, 'User unsubscribed successfully');

        // Return success page or JSON based on Accept header
        if (request.headers.accept?.includes('application/json')) {
          return reply.send({
            success: true,
            message: 'You have been unsubscribed from weekly emails.',
          });
        }

        return returnSuccessPage(reply);
      } catch (err) {
        logger.error({ err, requestId }, 'Failed to process unsubscribe');

        if (request.headers.accept?.includes('application/json')) {
          return reply.status(500).send({
            success: false,
            error: 'Failed to process unsubscribe request',
          });
        }

        return reply.status(500).type('text/html').send(`
          <!DOCTYPE html>
          <html>
          <head>
            <title>Error</title>
            <style>
              body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; padding: 40px; text-align: center; max-width: 600px; margin: 0 auto; }
              h1 { color: #e53e3e; }
              p { color: #4a5568; line-height: 1.6; }
            </style>
          </head>
          <body>
            <h1>Something went wrong</h1>
            <p>We couldn't process your unsubscribe request. Please try again later or contact us directly.</p>
          </body>
          </html>
        `);
      }
    }
  );
}

function returnSuccessPage(reply: FastifyReply) {
  return reply.type('text/html').send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Unsubscribed</title>
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; padding: 40px; text-align: center; max-width: 600px; margin: 0 auto; }
        h1 { color: #38a169; }
        p { color: #4a5568; line-height: 1.6; }
        a { color: #3182ce; }
        .check { font-size: 60px; margin-bottom: 20px; }
      </style>
    </head>
    <body>
      <div class="check">✓</div>
      <h1>Unsubscribed</h1>
      <p>You have been unsubscribed from weekly reminder emails.</p>
      <p>You can still book therapy sessions anytime at <a href="https://free.spill.app">free.spill.app</a></p>
    </body>
    </html>
  `);
}
