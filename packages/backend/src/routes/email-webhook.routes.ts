import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { OAuth2Client } from 'google-auth-library';
import { config } from '../config';
import { emailProcessingService } from '../services/email-processing.service';
import { logger } from '../utils/logger';
import { HEADERS, RATE_LIMITS } from '../constants';
import { sendSuccess, Errors } from '../utils/response';
import { safeCompare } from '../middleware/auth';

// FIX #43: Extract duplicated webhook secret check into a reusable helper
function verifyWebhookSecretHeader(request: FastifyRequest): boolean {
  const webhookSecret = request.headers[HEADERS.WEBHOOK_SECRET];
  return typeof webhookSecret === 'string' &&
    !!config.webhookSecret &&
    safeCompare(webhookSecret, config.webhookSecret);
}

// OAuth2 client for verifying Pub/Sub push tokens
const oauth2Client = new OAuth2Client();

// Google Pub/Sub push notification schema
const pubSubMessageSchema = z.object({
  message: z.object({
    data: z.string(), // Base64 encoded
    messageId: z.string(),
    publishTime: z.string(),
  }),
  subscription: z.string(),
});

// Decoded Gmail notification data
const gmailNotificationSchema = z.object({
  emailAddress: z.string(),
  historyId: z.number(),
});

export async function emailWebhookRoutes(fastify: FastifyInstance) {
  /**
   * POST /api/webhooks/gmail/push
   * Receives Gmail push notifications via Google Pub/Sub
   * FIX: Added rate limiting to prevent abuse from forged notifications
   */
  fastify.post(
    '/api/webhooks/gmail/push',
    {
      config: {
        rateLimit: {
          max: RATE_LIMITS.WEBHOOK.max,
          timeWindow: RATE_LIMITS.WEBHOOK.timeWindowMs,
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = request.id;
      logger.info({ requestId }, 'Received Gmail push notification');

      try {
        // Verify the request is from Google Pub/Sub
        // Google sends a bearer token in the Authorization header
        const authHeader = request.headers.authorization;
        if (authHeader && authHeader.startsWith('Bearer ')) {
          const token = authHeader.substring(7);
          try {
            // Verify the token is from Google
            const ticket = await oauth2Client.verifyIdToken({
              idToken: token,
              audience: config.googlePubsubAudience || undefined,
            });
            const payload = ticket.getPayload();

            // Verify the email is from Google's Pub/Sub service account
            if (payload?.email && !payload.email.endsWith('.gserviceaccount.com')) {
              logger.warn({ requestId, email: payload.email }, 'Pub/Sub token from non-Google service account');
              return reply.status(403).send({ success: false, error: 'Forbidden' });
            }

            logger.info({ requestId, issuer: payload?.iss }, 'Pub/Sub token verified');
          } catch (tokenErr) {
            logger.warn({ requestId, err: tokenErr }, 'Failed to verify Pub/Sub token');
            // SECURITY FIX: Always reject on token verification failure
            // Previously continued with warning, which allowed forged notifications
            return reply.status(403).send({ success: false, error: 'Invalid Pub/Sub token' });
          }
        } else if (config.requirePubsubAuth) {
          // No auth header - reject if auth is required
          // Pub/Sub ALWAYS sends Authorization header when configured, so missing header = forged request
          logger.warn({ requestId }, 'Missing Authorization header for Pub/Sub push - rejecting');
          return reply.status(401).send({ success: false, error: 'Unauthorized' });
        } else {
          // Auth not required - allow through with warning
          logger.warn({ requestId }, 'Missing Authorization header for Pub/Sub push - allowing (REQUIRE_PUBSUB_AUTH=false)');
        }

        // Parse Pub/Sub message
        const validation = pubSubMessageSchema.safeParse(request.body);
        if (!validation.success) {
          logger.warn({ requestId, errors: validation.error.errors }, 'Invalid Pub/Sub message');
          // Return 200 to acknowledge receipt (prevents retries)
          return reply.status(200).send({ success: false, error: 'Invalid message format' });
        }

        const { message } = validation.data;

        // Decode base64 data safely
        let notificationData: unknown;
        try {
          const decodedData = Buffer.from(message.data, 'base64').toString('utf-8');
          notificationData = JSON.parse(decodedData);
        } catch (parseErr) {
          logger.error({ requestId, parseErr, messageId: message.messageId }, 'Failed to parse notification data');
          // Return 200 to acknowledge (prevents retries for malformed messages)
          return reply.status(200).send({ success: false, error: 'Invalid JSON in notification data' });
        }

        logger.info(
          { requestId, messageId: message.messageId, notificationData },
          'Decoded Gmail notification'
        );

        // Validate notification data
        const notificationValidation = gmailNotificationSchema.safeParse(notificationData);
        if (!notificationValidation.success) {
          logger.warn({ requestId, errors: notificationValidation.error.errors }, 'Invalid notification data');
          return reply.status(200).send({ success: false, error: 'Invalid notification data' });
        }

        const { emailAddress, historyId } = notificationValidation.data;

        // Process the notification asynchronously
        // FIX H12: Added retry tracking for failed notifications
        emailProcessingService
          .processGmailNotification(emailAddress, historyId, requestId)
          .then(() => {
            logger.info({ requestId, historyId }, 'Gmail notification processed successfully');
          })
          .catch(async (err) => {
            logger.error({ err, requestId, historyId }, 'Failed to process Gmail notification');

            // FIX H12: Store failed notification for retry
            // The notification will be retried on next poll or manual trigger
            try {
              const { redis } = await import('../utils/redis');
              const historyIdStr = historyId.toString();

              // Store notification details for retry
              await redis.set(
                `gmail:failed:${historyIdStr}`,
                JSON.stringify({ emailAddress, historyId, requestId, failedAt: Date.now() }),
                'EX',
                3600 // 1 hour TTL
              );

              // Also add to the failed list for easier retrieval during retry
              const failedListKey = 'gmail:failed:list';
              const existingList = await redis.get(failedListKey);
              let failedIds: string[] = [];

              if (existingList) {
                try {
                  failedIds = JSON.parse(existingList);
                  if (!Array.isArray(failedIds)) failedIds = [];
                } catch {
                  failedIds = [];
                }
              }

              // Add if not already in list (prevents duplicates), cap at 100 entries
              if (!failedIds.includes(historyIdStr)) {
                failedIds.push(historyIdStr);
                // Trim to most recent 100 entries to prevent unbounded growth
                if (failedIds.length > 100) {
                  failedIds = failedIds.slice(-100);
                }
                await redis.set(failedListKey, JSON.stringify(failedIds), 'EX', 3600);
              }

              logger.info({ requestId, historyId }, 'Stored failed notification for retry');
            } catch (storeErr) {
              // Log but don't fail - notification will be caught by next poll
              logger.warn({ storeErr, historyId }, 'Failed to store notification for retry');
            }
          });

        // Acknowledge receipt immediately (Pub/Sub requirement)
        return reply.status(200).send({ success: true });
      } catch (err) {
        logger.error({ err, requestId }, 'Error handling Gmail push notification');
        // Return 200 to prevent infinite retries
        return reply.status(200).send({ success: false, error: 'Processing error' });
      }
    }
  );

  /**
   * POST /api/webhooks/gmail/poll
   * Manual trigger to poll for new emails (fallback/testing)
   */
  fastify.post(
    '/api/webhooks/gmail/poll',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = request.id;

      if (!verifyWebhookSecretHeader(request)) {
        return Errors.unauthorized(reply);
      }

      logger.info({ requestId }, 'Manual email poll triggered');

      try {
        const result = await emailProcessingService.pollForNewEmails(requestId);
        return reply.send({ success: true, data: result });
      } catch (err) {
        logger.error({ err, requestId }, 'Error polling for emails');
        return reply.status(500).send({ success: false, error: 'Failed to poll emails' });
      }
    }
  );

  /**
   * GET /api/webhooks/gmail/health
   * Health check for Gmail integration
   */
  fastify.get(
    '/api/webhooks/gmail/health',
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!verifyWebhookSecretHeader(request)) {
        return Errors.unauthorized(reply);
      }

      try {
        const status = await emailProcessingService.checkHealth();
        return reply.send({ success: true, data: status });
      } catch (err) {
        logger.error({ err }, 'Gmail health check failed');
        return reply.status(500).send({ success: false, error: 'Health check failed' });
      }
    }
  );

  /**
   * POST /api/webhooks/gmail/send-pending
   * Process and send all pending emails in the queue
   */
  fastify.post(
    '/api/webhooks/gmail/send-pending',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = request.id;

      if (!verifyWebhookSecretHeader(request)) {
        return Errors.unauthorized(reply);
      }

      logger.info({ requestId }, 'Processing pending emails');

      try {
        const result = await emailProcessingService.processPendingEmails(requestId);
        return reply.send({ success: true, data: result });
      } catch (err) {
        logger.error({ err, requestId }, 'Error processing pending emails');
        return reply.status(500).send({ success: false, error: 'Failed to process pending emails' });
      }
    }
  );

  /**
   * POST /api/webhooks/gmail/watch
   * Set up Gmail push notifications via Google Pub/Sub
   */
  fastify.post(
    '/api/webhooks/gmail/watch',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = request.id;

      if (!verifyWebhookSecretHeader(request)) {
        return Errors.unauthorized(reply);
      }

      const topicName = config.googlePubsubTopic;
      if (!topicName) {
        return Errors.badRequest(reply, 'GOOGLE_PUBSUB_TOPIC environment variable not configured');
      }

      logger.info({ requestId, topicName }, 'Setting up Gmail push notifications');

      try {
        const result = await emailProcessingService.setupPushNotifications(topicName);
        return sendSuccess(reply, {
          ...result,
          message: 'Gmail watch set up successfully. Push notifications will be sent to /api/webhooks/gmail/push',
        });
      } catch (err) {
        logger.error({ err, requestId }, 'Error setting up Gmail watch');
        return Errors.internal(reply, 'Failed to set up Gmail watch');
      }
    }
  );

  /**
   * POST /api/webhooks/gmail/send
   * Send a single email immediately via Gmail API
   */
  fastify.post(
    '/api/webhooks/gmail/send',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = request.id;

      if (!verifyWebhookSecretHeader(request)) {
        return Errors.unauthorized(reply);
      }

      const body = request.body as { to: string; subject: string; body: string };

      if (!body.to || !body.subject || !body.body) {
        return Errors.badRequest(reply, 'Missing required fields: to, subject, body');
      }

      // Validate email format and enforce size limits
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(body.to)) {
        return Errors.badRequest(reply, 'Invalid email address format');
      }
      if (body.subject.length > 998) {
        return Errors.badRequest(reply, 'Subject line exceeds maximum length (998 characters)');
      }
      if (body.body.length > 5_000_000) {
        return Errors.badRequest(reply, 'Email body exceeds maximum size (5MB)');
      }

      logger.info({ requestId, to: body.to, subject: body.subject }, 'Sending email directly');

      try {
        const result = await emailProcessingService.sendEmail(body);
        return reply.send({ success: true, data: result });
      } catch (err) {
        logger.error({ err, requestId }, 'Error sending email');
        return reply.status(500).send({ success: false, error: 'Failed to send email' });
      }
    }
  );
}
