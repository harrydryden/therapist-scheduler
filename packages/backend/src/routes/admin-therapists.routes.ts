/**
 * Admin Therapist Management Routes
 *
 * Reads and writes the Postgres `therapists` table. Postgres is the
 * single source of truth for therapist profile data; every consumer
 * (public listing, admin UI, booking flow, weekly mailing, ATS
 * integration) reads from here.
 *
 * Mutations:
 *   - active toggle     → Postgres
 *   - profile fields    → Postgres
 *   - force unfreeze    → clears TherapistBookingStatus.frozenAt
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../utils/database';
import { logger } from '../utils/logger';
import { verifyWebhookSecret } from '../middleware/auth';
import { sendSuccess, Errors } from '../utils/response';
import { RATE_LIMITS } from '../constants';
import {
  VALID_APPROACH_TYPES,
  VALID_STYLE_TYPES,
  VALID_AREAS_OF_FOCUS_TYPES,
} from '../config/therapist-categories';

const listTherapistsSchema = z.object({
  search: z.string().trim().max(255).optional(),
  active: z.enum(['true', 'false', 'all']).default('all'),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  sortBy: z.enum(['createdAt', 'name', 'ingestedAt']).default('ingestedAt'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
});

const updateTherapistSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    email: z.string().trim().email().max(255).optional(),
    bio: z.string().max(5000).nullable().optional(),
    country: z.string().trim().min(2).max(4).optional(),
    profileImage: z.string().url().max(2000).nullable().optional(),
    bookingLink: z.string().url().max(2000).nullable().optional(),
    active: z.boolean().optional(),
    approach: z.array(z.enum(VALID_APPROACH_TYPES as [string, ...string[]])).max(20).optional(),
    style: z.array(z.enum(VALID_STYLE_TYPES as [string, ...string[]])).max(20).optional(),
    areasOfFocus: z
      .array(z.enum(VALID_AREAS_OF_FOCUS_TYPES as [string, ...string[]]))
      .max(20)
      .optional(),
    // Availability is freeform JSON. Validation lives in
    // parseTherapistAvailability — we trust callers here so admins can hand-
    // edit complex shapes without the route re-implementing the parser.
    availability: z.unknown().optional(),
  })
  .strict();

function buildTherapistWhere(query: z.infer<typeof listTherapistsSchema>): Prisma.TherapistWhereInput {
  const where: Prisma.TherapistWhereInput = {};

  if (query.search) {
    const term = query.search;
    where.OR = [
      { email: { contains: term, mode: 'insensitive' } },
      { name: { contains: term, mode: 'insensitive' } },
      { odId: { contains: term } },
      { notionId: { contains: term } },
    ];
  }

  if (query.active === 'true') where.active = true;
  else if (query.active === 'false') where.active = false;

  return where;
}

export async function adminTherapistRoutes(fastify: FastifyInstance) {
  fastify.addHook('preHandler', verifyWebhookSecret);

  /**
   * GET /api/admin/therapists — paginated list of therapists from Postgres.
   * Each row is enriched with frozen state from TherapistBookingStatus and
   * an active-appointment count so the list page can show
   * "Frozen | 2 active" without an N+1 fetch.
   */
  fastify.get(
    '/api/admin/therapists',
    {
      config: {
        rateLimit: {
          max: RATE_LIMITS.ADMIN_ENDPOINTS.max,
          timeWindow: RATE_LIMITS.ADMIN_ENDPOINTS.timeWindowMs,
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = listTherapistsSchema.safeParse(request.query);
      if (!parsed.success) {
        return Errors.validationFailed(reply, parsed.error.errors);
      }

      const query = parsed.data;
      const where = buildTherapistWhere(query);

      try {
        const [therapists, total] = await Promise.all([
          prisma.therapist.findMany({
            where,
            orderBy: { [query.sortBy]: query.sortOrder },
            skip: (query.page - 1) * query.limit,
            take: query.limit,
            include: {
              _count: { select: { appointments: true } },
            },
          }),
          prisma.therapist.count({ where }),
        ]);

        // Pull frozen state for the page in a single query rather than per row.
        // Filter out null notionIds — post-Notion-deprecation therapists have
        // notionId=null, and Prisma 5 throws on null entries inside `in:`.
        // Their booking-status rows (when they exist) are keyed on the
        // Postgres uuid instead, so we union both lookup keys.
        const lookupKeys = therapists
          .map((t) => t.notionId ?? t.id)
          .filter((k): k is string => !!k);
        const statuses = lookupKeys.length
          ? await prisma.therapistBookingStatus.findMany({
              where: { id: { in: lookupKeys } },
              select: { id: true, frozenAt: true, hasConfirmedBooking: true, uniqueRequestCount: true },
            })
          : [];
        const statusByLookupKey = new Map(statuses.map((s) => [s.id, s]));

        const items = therapists.map((t) => {
          const status = statusByLookupKey.get(t.notionId ?? t.id);
          return {
            id: t.id,
            odId: t.odId,
            notionId: t.notionId,
            email: t.email,
            name: t.name,
            country: t.country,
            bio: t.bio,
            approach: t.approach,
            style: t.style,
            areasOfFocus: t.areasOfFocus,
            profileImage: t.profileImage,
            bookingLink: t.bookingLink,
            active: t.active,
            availability: t.availability,
            ingestedAt: t.ingestedAt?.toISOString() ?? null,
            createdAt: t.createdAt.toISOString(),
            updatedAt: t.updatedAt.toISOString(),
            appointmentCount: t._count.appointments,
            frozen: !!status?.frozenAt || !!status?.hasConfirmedBooking,
            uniqueRequestCount: status?.uniqueRequestCount ?? 0,
          };
        });

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
        logger.error({ err }, 'Failed to list therapists');
        return Errors.internal(reply, 'Failed to list therapists');
      }
    },
  );

  /**
   * GET /api/admin/therapists/:id — full therapist detail with linked
   * appointments (most recent 100). Looks up by Postgres uuid; use the list
   * endpoint to find the id from notionId or odId.
   */
  fastify.get<{ Params: { id: string } }>(
    '/api/admin/therapists/:id',
    {
      config: {
        rateLimit: {
          max: RATE_LIMITS.ADMIN_ENDPOINTS.max,
          timeWindow: RATE_LIMITS.ADMIN_ENDPOINTS.timeWindowMs,
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;

      try {
        const therapist = await prisma.therapist.findUnique({
          where: { id },
          include: {
            appointments: {
              orderBy: { createdAt: 'desc' },
              take: 100,
              select: {
                id: true,
                userName: true,
                userEmail: true,
                status: true,
                confirmedDateTimeParsed: true,
                createdAt: true,
                updatedAt: true,
              },
            },
          },
        });

        if (!therapist) {
          return Errors.notFound(reply, 'Therapist');
        }

        const status = await prisma.therapistBookingStatus.findUnique({
          where: { id: therapist.notionId },
          select: {
            frozenAt: true,
            hasConfirmedBooking: true,
            uniqueRequestCount: true,
            confirmedAt: true,
            adminAlertAt: true,
            adminAlertAcknowledged: true,
          },
        });

        return sendSuccess(reply, {
          id: therapist.id,
          odId: therapist.odId,
          notionId: therapist.notionId,
          email: therapist.email,
          name: therapist.name,
          country: therapist.country,
          bio: therapist.bio,
          approach: therapist.approach,
          style: therapist.style,
          areasOfFocus: therapist.areasOfFocus,
          profileImage: therapist.profileImage,
          bookingLink: therapist.bookingLink,
          active: therapist.active,
          availability: therapist.availability,
          ingestedAt: therapist.ingestedAt?.toISOString() ?? null,
          createdAt: therapist.createdAt.toISOString(),
          updatedAt: therapist.updatedAt.toISOString(),
          bookingStatus: status
            ? {
                frozen: !!status.frozenAt || !!status.hasConfirmedBooking,
                frozenAt: status.frozenAt?.toISOString() ?? null,
                hasConfirmedBooking: status.hasConfirmedBooking,
                confirmedAt: status.confirmedAt?.toISOString() ?? null,
                uniqueRequestCount: status.uniqueRequestCount,
                adminAlertAt: status.adminAlertAt?.toISOString() ?? null,
                adminAlertAcknowledged: status.adminAlertAcknowledged,
              }
            : null,
          appointments: therapist.appointments.map((a) => ({
            id: a.id,
            userName: a.userName,
            userEmail: a.userEmail,
            status: a.status,
            confirmedDateTimeParsed: a.confirmedDateTimeParsed?.toISOString() ?? null,
            createdAt: a.createdAt.toISOString(),
            updatedAt: a.updatedAt.toISOString(),
          })),
        });
      } catch (err) {
        logger.error({ err, therapistId: id }, 'Failed to fetch therapist');
        return Errors.internal(reply, 'Failed to fetch therapist');
      }
    },
  );

  /**
   * PATCH /api/admin/therapists/:id — edit profile fields in Postgres.
   * Active toggle dual-writes to Notion so the public therapist listing
   * (still Notion-backed in PR 1) reflects the change immediately. Profile
   * fields (bio, categories, image, link) write to Postgres only — they're
   * visible in the admin UI today and on the public site once PR 2 cuts the
   * read path over.
   */
  fastify.patch<{
    Params: { id: string };
    Body: z.infer<typeof updateTherapistSchema>;
  }>(
    '/api/admin/therapists/:id',
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
      const parsed = updateTherapistSchema.safeParse(request.body);
      if (!parsed.success) {
        return Errors.validationFailed(reply, parsed.error.errors);
      }

      const updates = parsed.data;
      if (Object.keys(updates).length === 0) {
        return Errors.badRequest(reply, 'No fields to update');
      }

      try {
        const before = await prisma.therapist.findUnique({ where: { id } });
        if (!before) {
          return Errors.notFound(reply, 'Therapist');
        }

        // Strip undefined keys so Prisma doesn't try to set them. Cast to a
        // partial update payload — Prisma accepts the JSON for `availability`.
        const data: Prisma.TherapistUpdateInput = {};
        if (updates.name !== undefined) data.name = updates.name;
        if (updates.email !== undefined) data.email = updates.email.toLowerCase().trim();
        if (updates.bio !== undefined) data.bio = updates.bio;
        if (updates.country !== undefined) data.country = updates.country;
        if (updates.profileImage !== undefined) data.profileImage = updates.profileImage;
        if (updates.bookingLink !== undefined) data.bookingLink = updates.bookingLink;
        if (updates.active !== undefined) data.active = updates.active;
        if (updates.approach !== undefined) data.approach = updates.approach;
        if (updates.style !== undefined) data.style = updates.style;
        if (updates.areasOfFocus !== undefined) data.areasOfFocus = updates.areasOfFocus;
        if (updates.availability !== undefined) {
          data.availability = updates.availability as Prisma.InputJsonValue;
        }

        const updated = await prisma.therapist.update({ where: { id }, data });

        // The PR 1 dual-write to Notion has been removed: Postgres is the
        // single source of truth for the active flag post-Notion-deprecation.

        logger.info(
          { therapistId: id, fields: Object.keys(updates) },
          'Admin updated therapist',
        );

        return sendSuccess(reply, {
          id: updated.id,
          name: updated.name,
          email: updated.email,
          active: updated.active,
        });
      } catch (err) {
        logger.error({ err, therapistId: id }, 'Failed to update therapist');
        return Errors.internal(reply, 'Failed to update therapist');
      }
    },
  );

  /**
   * POST /api/admin/therapists/:id/unfreeze — clear the freeze marker on
   * the therapist booking status row so they accept new requests again.
   *
   * Doesn't touch confirmed bookings: a therapist with a confirmed booking
   * stays frozen by virtue of `hasConfirmedBooking=true` regardless of
   * `frozenAt`. To "unfreeze" a therapist with an active confirmed booking,
   * cancel the booking via the existing appointments admin instead.
   */
  fastify.post<{ Params: { id: string } }>(
    '/api/admin/therapists/:id/unfreeze',
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
        const therapist = await prisma.therapist.findUnique({
          where: { id },
          select: { notionId: true, name: true },
        });
        if (!therapist) {
          return Errors.notFound(reply, 'Therapist');
        }

        // updateMany returns count=0 if there's no booking-status row yet;
        // that's fine — there's nothing to unfreeze.
        const result = await prisma.therapistBookingStatus.updateMany({
          where: { id: therapist.notionId },
          data: { frozenAt: null, frozenUntil: null },
        });

        // The previous Notion cache invalidation has been retired —
        // Postgres reads are direct, no cache to bust.

        logger.info(
          { therapistId: id, notionId: therapist.notionId, name: therapist.name, cleared: result.count },
          'Admin force-unfroze therapist',
        );

        return sendSuccess(reply, { unfrozen: result.count > 0 });
      } catch (err) {
        logger.error({ err, therapistId: id }, 'Failed to unfreeze therapist');
        return Errors.internal(reply, 'Failed to unfreeze therapist');
      }
    },
  );
}

