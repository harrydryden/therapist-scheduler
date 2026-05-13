import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { OAuth2Client } from 'google-auth-library';
import { config } from '../config';
import { emailProcessingService } from '../services/email-processing.service';
import { logger } from '../utils/logger';
import { RATE_LIMITS } from '../constants';
import { sendSuccess, Errors } from '../utils/response';
import { verifyWebhookSecret } from '../middleware/auth';

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

// Body schema for the direct-send endpoint. Caps match RFC 5322 (998-char
// subject) and a generous 5 MB body — sized for HTML emails with inline
// images. Email format is the standard zod check; downstream Gmail API
// will reject anything malformed.
const sendEmailSchema = z.object({
  to: z.string().email().max(320),
  subject: z.string().min(1).max(998),
  body: z.string().min(1).max(5_000_000),
});

// Shared options block for the admin-style Gmail control endpoints. Uses
// the central `verifyWebhookSecret` preHandler (which carries per-IP
// brute-force lockout) and the same rate-limit preset as other admin
// mutation routes. The Pub/Sub `/push` endpoint authenticates differently
// (Google ID token) and is registered separately below.
//
// DEPRECATED: these admin-style endpoints under `/api/webhooks/gmail/*`
// have canonical replacements under `/api/admin/gmail/*` and emit a
// `Deprecation: true` response header (RFC 8594) plus a `Link` header
// pointing at the successor path. A follow-up PR will remove them once
// operators have migrated.
const ADMIN_GMAIL_ROUTE_OPTS = {
  preHandler: verifyWebhookSecret,
  config: {
    rateLimit: {
      max: RATE_LIMITS.ADMIN_MUTATIONS.max,
      timeWindow: RATE_LIMITS.ADMIN_MUTATIONS.timeWindowMs,
    },
  },
};

/**
 * Mark a response as coming from a deprecated endpoint. Sets RFC 8594
 * headers and emits a `logger.warn` line so any remaining callers show
 * up in observability tooling. Call this at the top of every deprecated
 * handler.
 */
function markDeprecated(
  reply: FastifyReply,
  requestId: string,
  oldPath: string,
  successorPath: string,
): void {
  reply.header('Deprecation', 'true');
  reply.header('Link', `<${successorPath}>; rel="successor-version"`);
  logger.warn(
    { requestId, oldPath, successorPath },
    'Deprecated Gmail admin endpoint hit — migrate caller to the canonical path under /api/admin/gmail/*',
  );
}

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

            // FIX H12: Store failed notification for retry using atomic SADD
            // Previous read-modify-write on JSON list had a race condition where
            // concurrent failures could overwrite each other's additions.
            // SADD is atomic and handles deduplication natively.
            try {
              const { redis } = await import('../utils/redis');
              const historyIdStr = historyId.toString();

              // Store notification details for retry (keyed by historyId)
              await redis.set(
                `gmail:failed:${historyIdStr}`,
                JSON.stringify({ emailAddress, historyId, requestId, failedAt: Date.now() }),
                'EX',
                3600 // 1 hour TTL
              );

              // Add to the failed set atomically (SADD is atomic, no read-modify-write race)
              const failedSetKey = 'gmail:failed:set';
              await redis.sadd(failedSetKey, historyIdStr);
              await redis.expire(failedSetKey, 3600);

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
   * @deprecated POST /api/webhooks/gmail/poll — use POST /api/admin/gmail/poll
   */
  fastify.post(
    '/api/webhooks/gmail/poll',
    ADMIN_GMAIL_ROUTE_OPTS,
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = request.id;
      markDeprecated(reply, requestId, '/api/webhooks/gmail/poll', '/api/admin/gmail/poll');

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
   * @deprecated GET /api/webhooks/gmail/health — use GET /api/admin/gmail/status
   */
  fastify.get(
    '/api/webhooks/gmail/health',
    ADMIN_GMAIL_ROUTE_OPTS,
    async (request: FastifyRequest, reply: FastifyReply) => {
      markDeprecated(reply, request.id, '/api/webhooks/gmail/health', '/api/admin/gmail/status');

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
   * @deprecated POST /api/webhooks/gmail/send-pending — use POST /api/admin/gmail/send-pending
   */
  fastify.post(
    '/api/webhooks/gmail/send-pending',
    ADMIN_GMAIL_ROUTE_OPTS,
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = request.id;
      markDeprecated(reply, requestId, '/api/webhooks/gmail/send-pending', '/api/admin/gmail/send-pending');

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
   * @deprecated POST /api/webhooks/gmail/watch — use POST /api/admin/gmail/setup-push
   * (the canonical endpoint accepts an optional `topicName` body field;
   * if omitted it falls back to GOOGLE_PUBSUB_TOPIC just like this one).
   */
  fastify.post(
    '/api/webhooks/gmail/watch',
    ADMIN_GMAIL_ROUTE_OPTS,
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = request.id;
      markDeprecated(reply, requestId, '/api/webhooks/gmail/watch', '/api/admin/gmail/setup-push');

      const topicName = config.googlePubsubTopic;
      if (!topicName) {
        return Errors.badRequest(reply, 'GOOGLE_PUBSUB_TOPIC environment variable not configured');
      }

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
   * @deprecated POST /api/webhooks/gmail/send — use POST /api/admin/gmail/send
   */
  fastify.post(
    '/api/webhooks/gmail/send',
    ADMIN_GMAIL_ROUTE_OPTS,
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = request.id;
      markDeprecated(reply, requestId, '/api/webhooks/gmail/send', '/api/admin/gmail/send');

      const validation = sendEmailSchema.safeParse(request.body);
      if (!validation.success) {
        return Errors.validationFailed(reply, validation.error.errors);
      }
      const { to, subject, body } = validation.data;

      try {
        const result = await emailProcessingService.sendEmail({ to, subject, body });
        return reply.send({ success: true, data: result });
      } catch (err) {
        logger.error({ err, requestId }, 'Error sending email');
        return reply.status(500).send({ success: false, error: 'Failed to send email' });
      }
    }
  );
}
