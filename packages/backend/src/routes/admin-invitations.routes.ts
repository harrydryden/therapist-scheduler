/**
 * Admin Signup Invitation Routes
 *
 * - POST   /api/admin/invitations              create + email
 * - GET    /api/admin/invitations              list with filters + summary
 * - POST   /api/admin/invitations/:id/revoke   revoke a pending invitation
 * - POST   /api/admin/invitations/:id/resend   resend the email (no new token)
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { logger } from '../utils/logger';
import { verifyWebhookSecret } from '../middleware/auth';
import { sendSuccess, Errors } from '../utils/response';
import { RATE_LIMITS } from '../constants';
import { getSettingValue } from '../services/settings.service';
import {
  createInvitation,
  listInvitations,
  revokeInvitation,
  resendInvitationEmail,
  sendInvitationEmail,
  type InvitationStatus,
} from '../services/signup-invitation.service';
import { validateEmail } from '../utils/email-validator';

const createSchema = z.object({
  email: z.string().email().max(255),
  name: z.string().trim().min(1).max(100).optional(),
  /** Free-text label of the inviting admin (e.g. "Harry") for audit. */
  invitedBy: z.string().trim().min(1).max(100).default('admin'),
  /** Override the default invitation.expiryDays setting. */
  expiryDays: z.number().int().min(1).max(90).optional(),
  /** Skip sending the invitation email (admin will share the link manually). */
  sendEmail: z.boolean().default(true),
});

const listSchema = z.object({
  status: z.enum(['pending', 'accepted', 'revoked', 'expired', 'all']).default('all'),
  search: z.string().trim().max(255).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const bulkSchema = z.object({
  entries: z.array(z.object({
    email: z.string().email().max(255),
    name: z.string().trim().min(1).max(100).optional(),
  })).min(1).max(100),
  invitedBy: z.string().trim().min(1).max(100).default('admin'),
  expiryDays: z.number().int().min(1).max(90).optional(),
  sendEmail: z.boolean().default(true),
});

export async function adminInvitationRoutes(fastify: FastifyInstance) {
  fastify.addHook('preHandler', verifyWebhookSecret);

  // POST /api/admin/invitations
  fastify.post<{ Body: z.infer<typeof createSchema> }>(
    '/api/admin/invitations',
    {
      config: {
        rateLimit: {
          max: RATE_LIMITS.ADMIN_MUTATIONS.max,
          timeWindow: RATE_LIMITS.ADMIN_MUTATIONS.timeWindowMs,
        },
      },
    },
    async (request, reply) => {
      const requestId = request.id;
      const parsed = createSchema.safeParse(request.body);
      if (!parsed.success) {
        return Errors.validationFailed(reply, parsed.error.errors);
      }
      const { email, name, invitedBy, sendEmail } = parsed.data;

      // Validate email shape, MX, disposable, etc. — same gate the public
      // signup endpoint applies. Cheaper to reject here than mail and bounce.
      const emailValidation = await validateEmail(email, {
        checkMx: true,
        blockDisposable: true,
        suggestTypos: true,
      });
      if (!emailValidation.isValid) {
        return reply.status(400).send({
          success: false,
          error: emailValidation.errors[0] || 'Invalid email address',
          details: emailValidation.errors,
          suggestions: emailValidation.suggestions,
        });
      }

      const expiryDays = parsed.data.expiryDays
        ?? (await getSettingValue<number>('invitation.expiryDays'));

      try {
        const result = await createInvitation({ email, name, invitedBy, expiryDays });

        let emailSent = false;
        if (sendEmail) {
          emailSent = await sendInvitationEmail({
            email,
            recipientName: result.invitation.name,
            invitationUrl: result.invitationUrl,
            expiresAt: result.invitation.expiresAt,
          });
        }

        logger.info(
          {
            requestId,
            invitationId: result.invitation.id,
            email,
            invitedBy,
            emailSent,
          },
          'Invitation created'
        );

        return sendSuccess(
          reply,
          {
            invitation: serializeInvitation(result.invitation),
            invitationUrl: result.invitationUrl,
            emailSent,
          },
          { statusCode: 201 },
        );
      } catch (err) {
        logger.error({ err, requestId, email }, 'Failed to create invitation');
        return Errors.internal(reply, 'Failed to create invitation');
      }
    },
  );

  // GET /api/admin/invitations
  fastify.get(
    '/api/admin/invitations',
    {
      config: {
        rateLimit: {
          max: RATE_LIMITS.ADMIN_ENDPOINTS.max,
          timeWindow: RATE_LIMITS.ADMIN_ENDPOINTS.timeWindowMs,
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = listSchema.safeParse(request.query);
      if (!parsed.success) {
        return Errors.validationFailed(reply, parsed.error.errors);
      }

      try {
        const result = await listInvitations({
          status: parsed.data.status as InvitationStatus | 'all',
          search: parsed.data.search,
          page: parsed.data.page,
          limit: parsed.data.limit,
        });

        return sendSuccess(reply, {
          items: result.items.map(serializeInvitation),
          pagination: result.pagination,
          summary: result.summary,
        });
      } catch (err) {
        logger.error({ err }, 'Failed to list invitations');
        return Errors.internal(reply, 'Failed to list invitations');
      }
    },
  );

  // POST /api/admin/invitations/:id/revoke
  fastify.post<{ Params: { id: string } }>(
    '/api/admin/invitations/:id/revoke',
    {
      config: {
        rateLimit: {
          max: RATE_LIMITS.ADMIN_MUTATIONS.max,
          timeWindow: RATE_LIMITS.ADMIN_MUTATIONS.timeWindowMs,
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      try {
        const updated = await revokeInvitation(id);
        return sendSuccess(reply, serializeInvitation(updated));
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        if (message === 'Invitation not found') {
          return Errors.notFound(reply, 'Invitation');
        }
        if (message === 'Cannot revoke an already-accepted invitation') {
          return Errors.badRequest(reply, message);
        }
        logger.error({ err, invitationId: id }, 'Failed to revoke invitation');
        return Errors.internal(reply, 'Failed to revoke invitation');
      }
    },
  );

  // POST /api/admin/invitations/:id/resend
  fastify.post<{ Params: { id: string } }>(
    '/api/admin/invitations/:id/resend',
    {
      config: {
        rateLimit: {
          max: RATE_LIMITS.ADMIN_MUTATIONS.max,
          timeWindow: RATE_LIMITS.ADMIN_MUTATIONS.timeWindowMs,
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      try {
        const result = await resendInvitationEmail(id);
        return sendSuccess(reply, {
          invitation: serializeInvitation(result.invitation),
          emailSent: result.emailSent,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        if (message === 'Invitation not found') {
          return Errors.notFound(reply, 'Invitation');
        }
        if (message.startsWith('Cannot resend')) {
          return Errors.badRequest(reply, message);
        }
        logger.error({ err, invitationId: id }, 'Failed to resend invitation');
        return Errors.internal(reply, 'Failed to resend invitation');
      }
    },
  );

  // POST /api/admin/invitations/bulk
  //
  // Accepts up to 100 prospects in a single request. Each row is validated
  // and processed independently — one bad email doesn't fail the batch.
  // Returns a per-row result so the admin sees which entries succeeded
  // and which were rejected with reason.
  fastify.post<{ Body: z.infer<typeof bulkSchema> }>(
    '/api/admin/invitations/bulk',
    {
      config: {
        rateLimit: {
          // Bulk endpoint is heavier — tighter rate limit. Within one
          // window an admin can process 5 batches × 100 = 500 invites.
          max: 5,
          timeWindow: 60_000,
        },
      },
    },
    async (request, reply) => {
      const requestId = request.id;
      const parsed = bulkSchema.safeParse(request.body);
      if (!parsed.success) {
        return Errors.validationFailed(reply, parsed.error.errors);
      }
      const { entries, invitedBy, sendEmail, expiryDays: bodyExpiryDays } = parsed.data;
      const expiryDays = bodyExpiryDays
        ?? (await getSettingValue<number>('invitation.expiryDays'));

      const results: Array<{
        email: string;
        ok: boolean;
        invitationId?: string;
        invitationUrl?: string;
        emailSent?: boolean;
        error?: string;
      }> = [];

      for (const entry of entries) {
        try {
          const validation = await validateEmail(entry.email, {
            checkMx: true,
            blockDisposable: true,
            suggestTypos: true,
          });
          if (!validation.isValid) {
            results.push({
              email: entry.email,
              ok: false,
              error: validation.errors[0] || 'Invalid email address',
            });
            continue;
          }

          const created = await createInvitation({
            email: entry.email,
            name: entry.name,
            invitedBy,
            expiryDays,
          });

          let emailSent = false;
          if (sendEmail) {
            emailSent = await sendInvitationEmail({
              email: entry.email,
              recipientName: created.invitation.name,
              invitationUrl: created.invitationUrl,
              expiresAt: created.invitation.expiresAt,
            });
          }

          results.push({
            email: entry.email,
            ok: true,
            invitationId: created.invitation.id,
            invitationUrl: created.invitationUrl,
            emailSent,
          });
        } catch (err) {
          logger.warn(
            { err, requestId, email: entry.email },
            'Bulk invitation entry failed',
          );
          results.push({
            email: entry.email,
            ok: false,
            error: err instanceof Error ? err.message : 'Unknown error',
          });
        }
      }

      const succeeded = results.filter((r) => r.ok).length;
      const failed = results.length - succeeded;
      logger.info(
        { requestId, total: results.length, succeeded, failed },
        'Bulk invitation processed',
      );

      return sendSuccess(reply, {
        results,
        summary: { total: results.length, succeeded, failed },
      });
    },
  );
}

interface SerializedInvitation {
  id: string;
  email: string;
  name: string | null;
  invitedBy: string;
  status: 'pending' | 'accepted' | 'revoked' | 'expired';
  createdAt: string;
  expiresAt: string;
  acceptedAt: string | null;
  acceptedUserId: string | null;
  revokedAt: string | null;
  lastSentAt: string;
  sendCount: number;
}

function serializeInvitation(view: import('../services/signup-invitation.service').InvitationView): SerializedInvitation {
  return {
    id: view.id,
    email: view.email,
    name: view.name,
    invitedBy: view.invitedBy,
    status: view.status,
    createdAt: view.createdAt.toISOString(),
    expiresAt: view.expiresAt.toISOString(),
    acceptedAt: view.acceptedAt?.toISOString() ?? null,
    acceptedUserId: view.acceptedUserId,
    revokedAt: view.revokedAt?.toISOString() ?? null,
    lastSentAt: view.lastSentAt.toISOString(),
    sendCount: view.sendCount,
  };
}
