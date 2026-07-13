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
 *   - force unfreeze    → clears TherapistBookingStatus.manualFreezeAt
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../utils/database';
import { logger } from '../utils/logger';
import { verifyWebhookSecret } from '../middleware/auth';
import { sendSuccess, Errors } from '../utils/response';
import { RATE_LIMITS, ACTIVE_STATUSES } from '../constants';
import {
  VALID_APPROACH_TYPES,
  VALID_STYLE_TYPES,
  VALID_AREAS_OF_FOCUS_TYPES,
} from '../config/therapist-categories';
import {
  getTherapistProfile,
  addTherapistProfileNote,
  clearTherapistProfile,
  MAX_PROFILE_NOTE_LENGTH,
} from '../services/agent-profile.service';
import { parseTherapistAvailability } from '../utils/json-parser';

const addTherapistProfileNoteSchema = z.object({
  category: z.enum(['communication', 'scheduling', 'context']),
  text: z.string().trim().min(1).max(MAX_PROFILE_NOTE_LENGTH),
});

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
    // Per-therapist completed-client target driving public-site availability.
    targetAppointments: z.coerce.number().int().min(1).max(50).optional(),
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
          }),
          prisma.therapist.count({ where }),
        ]);

        // Booking-status rows and appointment aggregates are keyed on the
        // public handle: notionId for legacy rows, Postgres uuid for post-
        // Notion ingestions. `notionId ?? id` never yields null, so no need
        // to filter (Prisma 5 would throw on null entries inside `in:`).
        const lookupKeys = therapists.map((t) => t.notionId ?? t.id);

        // Three aggregates for the page, in parallel:
        //  - manual freeze markers (manualFreezeAt)
        //  - distinct completed clients per handle (the "Completed" column)
        //  - handles with any active appointment (drives "live" + is busy)
        const [statuses, completedRows, activeRows] = await Promise.all([
          prisma.therapistBookingStatus.findMany({
            where: { id: { in: lookupKeys } },
            select: { id: true, manualFreezeAt: true },
          }),
          prisma.appointmentRequest.groupBy({
            by: ['therapistHandle', 'userEmail'],
            where: { therapistHandle: { in: lookupKeys }, status: 'completed' },
          }),
          prisma.appointmentRequest.findMany({
            where: { therapistHandle: { in: lookupKeys }, status: { in: [...ACTIVE_STATUSES] } },
            select: { therapistHandle: true },
            distinct: ['therapistHandle'],
          }),
        ]);

        const frozenByHandle = new Map(statuses.map((s) => [s.id, !!s.manualFreezeAt]));
        const completedByHandle = new Map<string, number>();
        for (const row of completedRows) {
          completedByHandle.set(
            row.therapistHandle,
            (completedByHandle.get(row.therapistHandle) ?? 0) + 1,
          );
        }
        const activeSet = new Set(activeRows.map((r) => r.therapistHandle));

        const items = therapists.map((t) => {
          const handle = t.notionId ?? t.id;
          const frozen = frozenByHandle.get(handle) ?? false;
          const completedAppointmentCount = completedByHandle.get(handle) ?? 0;
          const hasActiveAppointment = activeSet.has(handle);
          // Live on the user site iff active, not manually frozen, short of
          // target, and not currently in a session (serial).
          const live =
            t.active &&
            !frozen &&
            !hasActiveAppointment &&
            completedAppointmentCount < t.targetAppointments;
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
            completedAppointmentCount,
            targetAppointments: t.targetAppointments,
            hasActiveAppointment,
            frozen,
            live,
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

        // Booking-status rows are keyed on the public handle (notionId for
        // legacy rows, Postgres uuid for post-Notion ingestions). Same
        // resolution as the list endpoint at line ~125.
        const handle = therapist.notionId ?? therapist.id;
        const [status, completedRows] = await Promise.all([
          prisma.therapistBookingStatus.findUnique({
            where: { id: handle },
            select: {
              manualFreezeAt: true,
              hasConfirmedBooking: true,
              uniqueRequestCount: true,
              confirmedAt: true,
              adminAlertAt: true,
              adminAlertAcknowledged: true,
            },
          }),
          prisma.appointmentRequest.groupBy({
            by: ['userEmail'],
            where: { therapistHandle: handle, status: 'completed' },
          }),
        ]);

        const completedAppointmentCount = completedRows.length;
        const hasActiveAppointment = therapist.appointments.some((a) =>
          (ACTIVE_STATUSES as readonly string[]).includes(a.status),
        );
        const frozen = !!status?.manualFreezeAt;
        const live =
          therapist.active &&
          !frozen &&
          !hasActiveAppointment &&
          completedAppointmentCount < therapist.targetAppointments;

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
          targetAppointments: therapist.targetAppointments,
          completedAppointmentCount,
          hasActiveAppointment,
          live,
          bookingStatus: status
            ? {
                frozen,
                frozenAt: status.manualFreezeAt?.toISOString() ?? null,
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
        if (updates.targetAppointments !== undefined) data.targetAppointments = updates.targetAppointments;
        if (updates.approach !== undefined) data.approach = updates.approach;
        if (updates.style !== undefined) data.style = updates.style;
        if (updates.areasOfFocus !== undefined) data.areasOfFocus = updates.areasOfFocus;
        if (updates.availability !== undefined) {
          // Run admin-supplied availability through the strict parser. This
          // drops malformed slots ("flexible", "Not specified", missing
          // start/end) before they reach the DB, so the public site can't
          // render garbage on the therapist card. An entirely-malformed blob
          // is rejected with 400 rather than silently stored.
          const validated = parseTherapistAvailability(updates.availability);
          if (validated === null) {
            return Errors.badRequest(
              reply,
              'availability must include a timezone and slots with full weekday names and HH:MM start/end times',
            );
          }
          data.availability = validated as unknown as Prisma.InputJsonValue;
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
   * POST /api/admin/therapists/:id/freeze — set the freeze marker on the
   * therapist booking status row so they stop accepting new requests.
   *
   * Manual escalation: complements the existing /unfreeze endpoint so an
   * admin can pin a therapist into the frozen state when the auto-unfreeze
   * logic has incorrectly released them (e.g. a conversation we're still
   * waiting on the therapist to reply to has gone past the inactivity
   * threshold).
   *
   * Upserts because a therapist with no prior bookings has no
   * therapist_booking_status row yet. The id field tracks the booking
   * handle (legacy notionId or post-Notion uuid).
   */
  fastify.post<{ Params: { id: string } }>(
    '/api/admin/therapists/:id/freeze',
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
          select: { id: true, notionId: true, name: true },
        });
        if (!therapist) {
          return Errors.notFound(reply, 'Therapist');
        }

        const handle = therapist.notionId ?? therapist.id;
        const now = new Date();

        await prisma.therapistBookingStatus.upsert({
          where: { id: handle },
          create: {
            id: handle,
            therapistName: therapist.name ?? '',
            uniqueRequestCount: 0,
            manualFreezeAt: now,
          },
          update: {
            manualFreezeAt: now,
          },
        });

        logger.info(
          { therapistId: id, notionId: therapist.notionId, name: therapist.name },
          'Admin force-froze therapist',
        );

        return sendSuccess(reply, { frozen: true });
      } catch (err) {
        logger.error({ err, therapistId: id }, 'Failed to freeze therapist');
        return Errors.internal(reply, 'Failed to freeze therapist');
      }
    },
  );

  /**
   * POST /api/admin/therapists/:id/unfreeze — clear the manual freeze marker
   * on the therapist booking status row so they accept new requests again.
   *
   * This only clears the deliberate admin freeze (`manualFreezeAt`). A
   * therapist who is simply busy (has an active appointment) or has reached
   * their completed-appointment target is still unavailable by the target
   * rule — unfreezing does not override those.
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
          select: { id: true, notionId: true, name: true },
        });
        if (!therapist) {
          return Errors.notFound(reply, 'Therapist');
        }

        // updateMany returns count=0 if there's no booking-status row yet;
        // that's fine — there's nothing to unfreeze. Booking-status rows
        // are keyed on the public handle (notionId for legacy, Postgres
        // uuid for post-Notion ingestions).
        const result = await prisma.therapistBookingStatus.updateMany({
          where: { id: therapist.notionId ?? therapist.id },
          data: { manualFreezeAt: null },
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

  /**
   * GET /api/admin/therapists/:id/agent-profile — Layer C profile. See
   * agent-profile.service.ts for the privacy contract.
   */
  fastify.get<{ Params: { id: string } }>(
    '/api/admin/therapists/:id/agent-profile',
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
        const profile = await getTherapistProfile(id);
        return sendSuccess(reply, profile);
      } catch (err) {
        logger.error({ err, therapistId: id }, 'Failed to read therapist agent profile');
        return Errors.internal(reply, 'Failed to read therapist agent profile');
      }
    },
  );

  /**
   * POST /api/admin/therapists/:id/agent-profile/notes — append an admin
   * note. Same shape as the user variant; deliberately kept as parallel
   * code paths so per-entity scoping cannot collapse in a future refactor.
   */
  fastify.post<{
    Params: { id: string };
    Body: z.infer<typeof addTherapistProfileNoteSchema>;
  }>(
    '/api/admin/therapists/:id/agent-profile/notes',
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
      const parsed = addTherapistProfileNoteSchema.safeParse(request.body);
      if (!parsed.success) {
        return Errors.validationFailed(reply, parsed.error.errors);
      }

      const exists = await prisma.therapist.findUnique({ where: { id }, select: { id: true } });
      if (!exists) {
        return Errors.notFound(reply, 'Therapist');
      }

      try {
        const result = await addTherapistProfileNote(id, {
          category: parsed.data.category,
          text: parsed.data.text,
          source: 'admin',
        });
        logger.info(
          { therapistId: id, category: parsed.data.category, added: result.added },
          'Admin added therapist agent-profile note',
        );
        return sendSuccess(reply, result);
      } catch (err) {
        logger.error({ err, therapistId: id }, 'Failed to add therapist agent-profile note');
        return Errors.internal(reply, 'Failed to add therapist agent-profile note');
      }
    },
  );

  /**
   * DELETE /api/admin/therapists/:id/agent-profile — wipe the profile.
   */
  fastify.delete<{ Params: { id: string } }>(
    '/api/admin/therapists/:id/agent-profile',
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
      const exists = await prisma.therapist.findUnique({ where: { id }, select: { id: true } });
      if (!exists) {
        return Errors.notFound(reply, 'Therapist');
      }

      try {
        await clearTherapistProfile(id);
        logger.info({ therapistId: id }, 'Admin cleared therapist agent profile');
        return sendSuccess(reply, { cleared: true });
      } catch (err) {
        logger.error({ err, therapistId: id }, 'Failed to clear therapist agent profile');
        return Errors.internal(reply, 'Failed to clear therapist agent profile');
      }
    },
  );
}

