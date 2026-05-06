/**
 * Admin User Management Routes
 *
 * Reads and lightly edits the Postgres `users` table — the new home for what
 * the Notion users database used to hold. Reads come exclusively from
 * Postgres so the admin UI can be used to verify Notion → Postgres parity
 * during PR 1 of the Notion deprecation.
 *
 * Writes that have a Notion equivalent (subscribed toggle) dual-write so the
 * existing weekly-mailing eligibility query — which still reads from Notion
 * — stays consistent until PR 2 cuts that read path over.
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../utils/database';
import { logger } from '../utils/logger';
import { verifyWebhookSecret } from '../middleware/auth';
import { sendSuccess, Errors } from '../utils/response';
import { RATE_LIMITS, APPOINTMENT_STATUS } from '../constants';

const listUsersSchema = z.object({
  search: z.string().trim().max(255).optional(),
  subscribed: z.enum(['true', 'false', 'all']).default('all'),
  signupSource: z.enum(['signup_form', 'invitation', 'booking', 'admin', 'legacy', 'all']).default('all'),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  sortBy: z.enum(['createdAt', 'email', 'name', 'consentGivenAt']).default('createdAt'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
});

const updateUserSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  country: z.string().trim().min(2).max(4).optional(),
  subscribed: z.boolean().optional(),
});

function buildUserWhere(query: z.infer<typeof listUsersSchema>): Prisma.UserWhereInput {
  const where: Prisma.UserWhereInput = {};

  if (query.search) {
    const term = query.search;
    where.OR = [
      { email: { contains: term, mode: 'insensitive' } },
      { name: { contains: term, mode: 'insensitive' } },
      { odId: { contains: term } },
    ];
  }

  if (query.subscribed === 'true') where.subscribed = true;
  else if (query.subscribed === 'false') where.subscribed = false;

  if (query.signupSource !== 'all') {
    where.signupSource = query.signupSource;
  }

  return where;
}

export async function adminUserRoutes(fastify: FastifyInstance) {
  fastify.addHook('preHandler', verifyWebhookSecret);

  /**
   * GET /api/admin/users — paginated list with search and filters.
   * Each row carries an aggregate `appointmentCount` (no relation join, just
   * a count) so the list page can show "5 appointments" without a per-row
   * fetch.
   */
  fastify.get(
    '/api/admin/users',
    {
      config: {
        rateLimit: {
          max: RATE_LIMITS.ADMIN_ENDPOINTS.max,
          timeWindow: RATE_LIMITS.ADMIN_ENDPOINTS.timeWindowMs,
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = listUsersSchema.safeParse(request.query);
      if (!parsed.success) {
        return Errors.validationFailed(reply, parsed.error.errors);
      }

      const query = parsed.data;
      const where = buildUserWhere(query);

      try {
        const [users, total] = await Promise.all([
          prisma.user.findMany({
            where,
            orderBy: { [query.sortBy]: query.sortOrder },
            skip: (query.page - 1) * query.limit,
            take: query.limit,
            include: {
              _count: { select: { appointments: true } },
            },
          }),
          prisma.user.count({ where }),
        ]);

        const items = users.map((u) => ({
          id: u.id,
          odId: u.odId,
          email: u.email,
          name: u.name,
          country: u.country,
          subscribed: u.subscribed,
          priorTherapy: u.priorTherapy,
          acknowledgedRealSession: u.acknowledgedRealSession,
          agreedToFeedback: u.agreedToFeedback,
          consentGivenAt: u.consentGivenAt?.toISOString() ?? null,
          signupSource: u.signupSource,
          appointmentCount: u._count.appointments,
          createdAt: u.createdAt.toISOString(),
          updatedAt: u.updatedAt.toISOString(),
        }));

        return sendSuccess(reply, {
          items,
          pagination: {
            page: query.page,
            limit: query.limit,
            total,
            totalPages: Math.ceil(total / query.limit),
          },
        });
      } catch (err) {
        logger.error({ err }, 'Failed to list users');
        return Errors.internal(reply, 'Failed to list users');
      }
    },
  );

  /**
   * GET /api/admin/users/:id — full user detail with appointment history.
   * The history is a denormalized projection (no nested objects) sized to
   * fit comfortably on the detail page; for users with hundreds of
   * appointments callers should fall back to the existing appointments
   * search.
   */
  fastify.get<{ Params: { id: string } }>(
    '/api/admin/users/:id',
    {
      config: {
        rateLimit: {
          max: RATE_LIMITS.ADMIN_ENDPOINTS.max,
          timeWindow: RATE_LIMITS.ADMIN_ENDPOINTS.timeWindowMs,
        },
      },
    },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const { id } = request.params;

      try {
        const user = await prisma.user.findUnique({
          where: { id },
          include: {
            appointments: {
              orderBy: { createdAt: 'desc' },
              take: 100,
              select: {
                id: true,
                therapistName: true,
                therapistEmail: true,
                status: true,
                confirmedDateTimeParsed: true,
                createdAt: true,
                updatedAt: true,
              },
            },
          },
        });

        if (!user) {
          return Errors.notFound(reply, 'User');
        }

        // Surface voucher tracking alongside the user so the detail page can
        // show "subscribed | strikes: 0 | last voucher sent: ..." without a
        // second round trip.
        const voucher = await prisma.voucherTracking.findUnique({
          where: { id: user.email.toLowerCase() },
          select: {
            strikeCount: true,
            lastVoucherSentAt: true,
            lastVoucherUsedAt: true,
            unsubscribedAt: true,
          },
        });

        return sendSuccess(reply, {
          id: user.id,
          odId: user.odId,
          email: user.email,
          name: user.name,
          country: user.country,
          subscribed: user.subscribed,
          priorTherapy: user.priorTherapy,
          acknowledgedRealSession: user.acknowledgedRealSession,
          agreedToFeedback: user.agreedToFeedback,
          consentGivenAt: user.consentGivenAt?.toISOString() ?? null,
          signupSource: user.signupSource,
          createdAt: user.createdAt.toISOString(),
          updatedAt: user.updatedAt.toISOString(),
          voucher: voucher
            ? {
                strikeCount: voucher.strikeCount,
                lastVoucherSentAt: voucher.lastVoucherSentAt?.toISOString() ?? null,
                lastVoucherUsedAt: voucher.lastVoucherUsedAt?.toISOString() ?? null,
                unsubscribedAt: voucher.unsubscribedAt?.toISOString() ?? null,
              }
            : null,
          appointments: user.appointments.map((a) => ({
            id: a.id,
            therapistName: a.therapistName,
            therapistEmail: a.therapistEmail,
            status: a.status,
            confirmedDateTimeParsed: a.confirmedDateTimeParsed?.toISOString() ?? null,
            createdAt: a.createdAt.toISOString(),
            updatedAt: a.updatedAt.toISOString(),
          })),
        });
      } catch (err) {
        logger.error({ err, userId: id }, 'Failed to fetch user');
        return Errors.internal(reply, 'Failed to fetch user');
      }
    },
  );

  /**
   * PATCH /api/admin/users/:id — edit subset of user fields.
   * Subscribed toggles dual-write to Notion so the weekly mailing query
   * (still Notion-backed in PR 1) reflects the change immediately.
   */
  fastify.patch<{ Params: { id: string }; Body: z.infer<typeof updateUserSchema> }>(
    '/api/admin/users/:id',
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
      const parsed = updateUserSchema.safeParse(request.body);
      if (!parsed.success) {
        return Errors.validationFailed(reply, parsed.error.errors);
      }

      const updates = parsed.data;
      if (Object.keys(updates).length === 0) {
        return Errors.badRequest(reply, 'No fields to update');
      }

      try {
        const before = await prisma.user.findUnique({ where: { id } });
        if (!before) {
          return Errors.notFound(reply, 'User');
        }

        const updated = await prisma.user.update({
          where: { id },
          data: updates,
        });

        // The PR 1 dual-write to Notion has been removed: Postgres is the
        // single source of truth for `subscribed` post-Notion-deprecation.

        logger.info(
          { userId: id, fields: Object.keys(updates) },
          'Admin updated user',
        );

        return sendSuccess(reply, {
          id: updated.id,
          email: updated.email,
          name: updated.name,
          country: updated.country,
          subscribed: updated.subscribed,
        });
      } catch (err) {
        logger.error({ err, userId: id }, 'Failed to update user');
        return Errors.internal(reply, 'Failed to update user');
      }
    },
  );
}
