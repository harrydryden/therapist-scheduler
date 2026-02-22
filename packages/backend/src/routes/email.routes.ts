import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { prisma } from '../utils/database';
import { logger } from '../utils/logger';
import { JustinTimeService } from '../services/justin-time.service';
import { INPUT_LIMITS } from '../constants';
import { adminAuthHook } from '../middleware/auth';
import { sendSuccess, Errors } from '../utils/response';
import { parseConversationState } from '../utils/json-parser';

/**
 * Sanitize email body to remove potentially malicious content
 * - Strips HTML tags (emails should be plain text)
 * - Removes null bytes and control characters
 * - Normalizes whitespace
 */
function sanitizeEmailBody(body: string): string {
  return body
    // Remove HTML tags
    .replace(/<[^>]*>/g, '')
    // Remove null bytes and most control characters (keep newlines and tabs)
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    // Normalize multiple spaces to single space (but preserve newlines)
    .replace(/[^\S\n]+/g, ' ')
    // Trim each line
    .split('\n')
    .map(line => line.trim())
    .join('\n')
    // Remove excessive newlines (more than 3 in a row)
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
}

const incomingEmailSchema = z.object({
  fromEmail: z.string().email().max(INPUT_LIMITS.MAX_EMAIL_LENGTH),
  subject: z.string().max(INPUT_LIMITS.MAX_EMAIL_SUBJECT_LENGTH),
  body: z
    .string()
    .max(INPUT_LIMITS.MAX_EMAIL_BODY_LENGTH)
    .transform(sanitizeEmailBody)
    .refine((val) => val.length > 0, {
      message: 'Email body cannot be empty after sanitization',
    }),
  messageId: z.string().max(INPUT_LIMITS.MAX_NAME_LENGTH).optional(),
});

export async function emailRoutes(fastify: FastifyInstance) {
  /**
   * GET /api/emails/pending - Get all pending emails to send
   * Called by external process with Gmail MCP access
   */
  fastify.get(
    '/api/emails/pending',
    { ...adminAuthHook },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = request.id;

      try {
        const pendingEmails = await prisma.pendingEmail.findMany({
          where: { status: 'pending' },
          orderBy: { createdAt: 'asc' },
          take: 10,
        });

        return sendSuccess(reply, pendingEmails, { count: pendingEmails.length });
      } catch (err) {
        logger.error({ err, requestId }, 'Failed to fetch pending emails');
        return Errors.internal(reply, 'Failed to fetch pending emails');
      }
    }
  );

  /**
   * POST /api/emails/:id/mark-sent - Mark an email as sent
   * Called after external process sends the email via Gmail MCP
   */
  fastify.post<{ Params: { id: string } }>(
    '/api/emails/:id/mark-sent',
    { ...adminAuthHook },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const { id } = request.params;
      const requestId = request.id;

      try {
        await prisma.pendingEmail.update({
          where: { id },
          data: {
            status: 'sent',
            sentAt: new Date(),
          },
        });

        logger.info({ requestId, emailId: id }, 'Email marked as sent');

        return sendSuccess(reply, null, { message: 'Email marked as sent' });
      } catch (err) {
        logger.error({ err, requestId, emailId: id }, 'Failed to mark email as sent');
        return Errors.internal(reply, 'Failed to mark email as sent');
      }
    }
  );

  /**
   * POST /api/emails/incoming - Handle incoming email reply
   * Called when a reply is received (via Gmail webhook or polling)
   */
  fastify.post(
    '/api/emails/incoming',
    { ...adminAuthHook },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = request.id;

      // Validate body
      const validation = incomingEmailSchema.safeParse(request.body);
      if (!validation.success) {
        return Errors.validationFailed(reply, validation.error.errors);
      }

      const { fromEmail, subject, body } = validation.data;

      logger.info({ requestId, fromEmail, subject }, 'Received incoming email');

      try {
        // Find matching appointment request by email address
        // FIX EMAIL-CONTEXT: Include 'confirmed' status to handle post-booking emails
        // (e.g., reschedule requests, questions about the session)
        const appointmentRequest = await prisma.appointmentRequest.findFirst({
          where: {
            OR: [
              { userEmail: fromEmail },
              { therapistEmail: fromEmail },
            ],
            status: {
              in: ['pending', 'contacted', 'negotiating', 'confirmed'],
            },
          },
          orderBy: { updatedAt: 'desc' },
        });

        if (!appointmentRequest) {
          logger.warn({ requestId, fromEmail }, 'No matching appointment request found for email');
          return Errors.notFound(reply, 'Matching appointment request');
        }

        // Process the email with Justin Time
        const justinTime = new JustinTimeService(requestId);
        await justinTime.processEmailReply(
          appointmentRequest.id,
          body,
          fromEmail
        );

        logger.info(
          { requestId, appointmentRequestId: appointmentRequest.id, fromEmail },
          'Email reply processed successfully'
        );

        return sendSuccess(reply, {
          appointmentRequestId: appointmentRequest.id,
          message: 'Email processed and response queued',
        });
      } catch (err) {
        logger.error({ err, requestId, fromEmail }, 'Failed to process incoming email');
        return Errors.internal(reply, 'Failed to process incoming email');
      }
    }
  );

  /**
   * GET /api/emails/appointments/:id/conversation - Get conversation history
   * Useful for debugging and monitoring
   */
  fastify.get<{ Params: { id: string } }>(
    '/api/emails/appointments/:id/conversation',
    { ...adminAuthHook },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const { id } = request.params;
      const requestId = request.id;

      try {
        const appointmentRequest = await prisma.appointmentRequest.findUnique({
          where: { id },
          select: {
            id: true,
            userEmail: true,
            therapistEmail: true,
            therapistName: true,
            status: true,
            conversationState: true,
            createdAt: true,
            updatedAt: true,
          },
        });

        if (!appointmentRequest) {
          return Errors.notFound(reply, 'Appointment request');
        }

        // Parse conversation state using centralized utility
        const conversation = parseConversationState(appointmentRequest.conversationState);

        return sendSuccess(reply, {
          ...appointmentRequest,
          conversationState: undefined,
          conversation,
        });
      } catch (err) {
        logger.error({ err, requestId, appointmentId: id }, 'Failed to fetch conversation');
        return Errors.internal(reply, 'Failed to fetch conversation');
      }
    }
  );
}
