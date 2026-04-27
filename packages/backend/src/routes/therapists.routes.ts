import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { notionService } from '../services/notion.service';
import { therapistBookingStatusService } from '../services/therapist-booking-status.service';
import { prisma } from '../utils/database';
import { getOrCreateTherapist } from '../utils/unique-id';
import { logger } from '../utils/logger';
import { RATE_LIMITS } from '../constants';
import { adminAuthHook } from '../middleware/auth';
import { sendSuccess, Errors } from '../utils/response';
import type { TherapistAvailability } from '@therapist-scheduler/shared';

interface GetTherapistParams {
  id: string;
}

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
      // Fetch Notion therapists (for static profile data), unavailability
      // status, and the Postgres records (which carry availability/country/
      // ingestion date — Postgres is the source of truth for these now).
      const [therapists, unavailableIds, therapistRecords] = await Promise.all([
        notionService.fetchTherapists(),
        therapistBookingStatusService.getUnavailableTherapistIds(),
        prisma.therapist.findMany({
          select: { notionId: true, ingestedAt: true, country: true, availability: true },
        }),
      ]);
      const unavailableSet = new Set(unavailableIds);

      // Build maps keyed on Notion ID for quick join
      const ingestedAtMap = new Map<string, Date>();
      const countryMap = new Map<string, string>();
      const availabilityMap = new Map<string, TherapistAvailability | null>();
      const now = new Date();
      for (const record of therapistRecords) {
        ingestedAtMap.set(record.notionId, record.ingestedAt ?? now);
        countryMap.set(record.notionId, record.country);
        availabilityMap.set(record.notionId, (record.availability as unknown) as TherapistAvailability | null);
      }

      // Lazily create Prisma records for Notion therapists missing from the DB
      // (e.g. therapists added to Notion before ingestion tracking was introduced)
      const missingTherapists = therapists.filter((t) => !ingestedAtMap.has(t.id));
      if (missingTherapists.length > 0) {
        await Promise.allSettled(
          missingTherapists.map(async (t) => {
            try {
              const record = await getOrCreateTherapist(t.id, t.email, t.name);
              ingestedAtMap.set(t.id, record.ingestedAt ?? now);
              countryMap.set(t.id, record.country);
              availabilityMap.set(t.id, (record.availability as unknown) as TherapistAvailability | null);
            } catch (err) {
              logger.warn({ err, notionId: t.id }, 'Failed to backfill Prisma therapist record');
              ingestedAtMap.set(t.id, now);
            }
          })
        );
      }

      logger.info(
        { requestId, unavailableCount: unavailableIds.length },
        'Filtering out unavailable therapists'
      );

      // Filter out unavailable therapists and transform for API response
      // NOTE: Email is intentionally NOT included in public API response for privacy
      const response = therapists
        .filter((t) => !unavailableSet.has(t.id))
        .map((t) => {
          const availability = availabilityMap.get(t.id) ?? null;
          return {
            id: t.id,
            name: t.name,
            bio: t.bio,
            // Category system
            approach: t.approach,
            style: t.style,
            areasOfFocus: t.areasOfFocus,
            // email intentionally omitted - not public information
            availability,
            active: t.active,
            availabilitySummary: formatAvailabilitySummary(availability),
            profileImage: t.profileImage,
            bookingLink: t.bookingLink,
            acceptingBookings: true, // Only available therapists are in this list
            // Country code drives flag emoji on the card and timezone handling.
            // Defaults to 'UK' when no Prisma record yet exists.
            country: countryMap.get(t.id) ?? 'UK',
          };
        })
        // Sort by ingestion date: longest on platform first (oldest date first)
        // Therapists without a Prisma record are treated as added today
        .sort((a, b) => {
          const dateA = ingestedAtMap.get(a.id) ?? now;
          const dateB = ingestedAtMap.get(b.id) ?? now;
          return dateA.getTime() - dateB.getTime();
        });

      return sendSuccess(reply, response, { count: response.length });
    } catch (err) {
      logger.error({ err, requestId }, 'Failed to fetch therapists');
      return Errors.internal(reply, 'Failed to fetch therapists');
    }
  });

  // GET /api/therapists/:id - Get single therapist details
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
        // Fetch Notion profile, booking status, and the Postgres record
        // (country + availability) in parallel.
        const [therapist, availabilityStatus, prismaRecord] = await Promise.all([
          notionService.getTherapist(id),
          therapistBookingStatusService.canAcceptNewRequest(id, ''),
          prisma.therapist.findUnique({
            where: { notionId: id },
            select: { country: true, availability: true },
          }),
        ]);

        if (!therapist) {
          return Errors.notFound(reply, 'Therapist');
        }

        const acceptingBookings = availabilityStatus.canAcceptNewRequests;
        const availability = ((prismaRecord?.availability as unknown) as TherapistAvailability | null) ?? null;

        // Full response for detail view
        // NOTE: Email is intentionally NOT included in public API response for privacy
        const response = {
          id: therapist.id,
          name: therapist.name,
          bio: therapist.bio,
          // Category system
          approach: therapist.approach,
          style: therapist.style,
          areasOfFocus: therapist.areasOfFocus,
          // email intentionally omitted - not public information
          availability,
          active: therapist.active,
          availabilitySummary: formatAvailabilitySummary(availability),
          acceptingBookings,
          profileImage: therapist.profileImage,
          bookingLink: therapist.bookingLink,
          country: prismaRecord?.country ?? 'UK',
        };

        return sendSuccess(reply, response);
      } catch (err) {
        logger.error({ err, requestId, therapistId: id }, 'Failed to fetch therapist');
        return Errors.internal(reply, 'Failed to fetch therapist');
      }
    }
  );

  // POST /api/therapists/invalidate-cache - Force cache refresh (admin endpoint)
  fastify.post(
    '/api/therapists/invalidate-cache',
    { ...adminAuthHook },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = request.id;
      logger.info({ requestId }, 'Invalidating therapist cache');

      try {
        await notionService.invalidateCache();
        return sendSuccess(reply, null, { message: 'Cache invalidated' });
      } catch (err) {
        logger.error({ err, requestId }, 'Failed to invalidate cache');
        return Errors.internal(reply, 'Failed to invalidate cache');
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
