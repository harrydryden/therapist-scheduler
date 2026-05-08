import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { therapistBookingStatusService } from '../services/therapist-booking-status.service';
import { prisma } from '../utils/database';
import { logger } from '../utils/logger';
import { RATE_LIMITS } from '../constants';
import { sendSuccess, Errors } from '../utils/response';
import type { TherapistAvailability } from '@therapist-scheduler/shared';

interface GetTherapistParams {
  id: string;
}

/**
 * Public therapist routes. Reads come exclusively from Postgres now that
 * Notion is no longer authoritative (see Notion deprecation PR 2). The
 * `id` returned to the frontend is the therapist's `notionId` for legacy
 * rows and the Postgres uuid for newer rows that never had a Notion page;
 * the booking flow accepts either.
 */
export async function therapistRoutes(fastify: FastifyInstance) {
  // GET /api/therapists - List all active therapists available for booking
  fastify.get(
    '/api/therapists',
    {
      config: {
        rateLimit: {
          max: RATE_LIMITS.PUBLIC_THERAPIST_LIST.max,
          timeWindow: RATE_LIMITS.PUBLIC_THERAPIST_LIST.timeWindowMs,
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
    const requestId = request.id;
    logger.info({ requestId }, 'Fetching all therapists');

    try {
      // Postgres is now the single source of truth. Fetch active therapists
      // and compute the unavailable set in parallel; we filter out any
      // therapist whose booking status flags them as frozen/confirmed.
      const [therapists, unavailableNotionIds] = await Promise.all([
        prisma.therapist.findMany({
          where: { active: true },
          orderBy: { ingestedAt: 'asc' }, // longest on platform first
        }),
        therapistBookingStatusService.getUnavailableTherapistIds(),
      ]);
      const unavailableSet = new Set(unavailableNotionIds);

      const now = new Date();

      // NOTE: Email is intentionally NOT included in public API response for privacy
      const response = therapists
        .filter((t) => {
          // therapistBookingStatus is keyed on the same handle the booking
          // flow uses: notionId for legacy rows, Postgres uuid for post-
          // Notion ingestions. Match that here so frozen post-Notion
          // therapists don't slip through with `notionId = null`.
          const lookupKey = t.notionId ?? t.id;
          if (unavailableSet.has(lookupKey)) return false;
          return true;
        })
        .map((t) => {
          const availability = (t.availability as unknown) as TherapistAvailability | null;
          return {
            id: t.notionId ?? t.id,
            name: t.name,
            bio: t.bio,
            approach: t.approach,
            style: t.style,
            areasOfFocus: t.areasOfFocus,
            availability,
            active: t.active,
            availabilitySummary: formatAvailabilitySummary(availability),
            profileImage: t.profileImage,
            bookingLink: t.bookingLink,
            acceptingBookings: true,
            country: t.country,
            ingestedAt: (t.ingestedAt ?? now).toISOString(),
          };
        });

      logger.info(
        { requestId, count: response.length, unavailableCount: unavailableNotionIds.length },
        'Returned therapists',
      );
      return sendSuccess(reply, response, { count: response.length });
    } catch (err) {
      logger.error({ err, requestId }, 'Failed to fetch therapists');
      return Errors.internal(reply, 'Failed to fetch therapists');
    }
  });

  // GET /api/therapists/:id - Get single therapist details
  // `id` is whatever the public list returned: notionId for legacy rows,
  // Postgres uuid for post-Notion rows.
  fastify.get<{ Params: GetTherapistParams }>(
    '/api/therapists/:id',
    {
      config: {
        rateLimit: {
          max: RATE_LIMITS.PUBLIC_THERAPIST_LIST.max,
          timeWindow: RATE_LIMITS.PUBLIC_THERAPIST_LIST.timeWindowMs,
        },
      },
    },
    async (request: FastifyRequest<{ Params: GetTherapistParams }>, reply: FastifyReply) => {
      const { id } = request.params;
      const requestId = request.id;
      logger.info({ requestId, therapistId: id }, 'Fetching single therapist');

      try {
        // Match by either notionId (legacy) or Postgres id (post-Notion).
        const therapist = await prisma.therapist.findFirst({
          where: { OR: [{ notionId: id }, { id }] },
        });

        if (!therapist || !therapist.active) {
          return Errors.notFound(reply, 'Therapist');
        }

        // Use the legacy notionId for the booking-status lookup when present;
        // post-Notion therapists fall back to Postgres id (booking-status
        // rows for new therapists are keyed on the same value the public
        // list returned).
        const lookupKey = therapist.notionId ?? therapist.id;
        const availabilityStatus = await therapistBookingStatusService.canAcceptNewRequest(
          lookupKey,
          '',
        );

        const acceptingBookings = availabilityStatus.canAcceptNewRequests;
        const availability = (therapist.availability as unknown) as TherapistAvailability | null;

        const response = {
          id: therapist.notionId ?? therapist.id,
          name: therapist.name,
          bio: therapist.bio,
          approach: therapist.approach,
          style: therapist.style,
          areasOfFocus: therapist.areasOfFocus,
          availability,
          active: therapist.active,
          availabilitySummary: formatAvailabilitySummary(availability),
          acceptingBookings,
          profileImage: therapist.profileImage,
          bookingLink: therapist.bookingLink,
          country: therapist.country,
        };

        return sendSuccess(reply, response);
      } catch (err) {
        logger.error({ err, requestId, therapistId: id }, 'Failed to fetch therapist');
        return Errors.internal(reply, 'Failed to fetch therapist');
      }
    }
  );
}

function formatAvailabilitySummary(availability: TherapistAvailability | null): string {
  if (!availability || !availability.slots || availability.slots.length === 0) {
    return 'Contact for availability';
  }

  const days = availability.slots.map((slot) => slot.day);
  const uniqueDays = [...new Set(days)];

  if (uniqueDays.length === 5) {
    return 'Weekdays';
  }

  return uniqueDays.join(', ');
}
