import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { notionService, Therapist } from '../services/notion.service';
import { therapistBookingStatusService } from '../services/therapist-booking-status.service';
import { logger } from '../utils/logger';
import { RATE_LIMITS } from '../constants';
import { adminAuthHook } from '../middleware/auth';
import { sendSuccess, Errors } from '../utils/response';

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
      // Fetch therapists and unavailability status in parallel (independent operations)
      const [therapists, unavailableIds] = await Promise.all([
        notionService.fetchTherapists(),
        therapistBookingStatusService.getUnavailableTherapistIds(),
      ]);
      const unavailableSet = new Set(unavailableIds);

      logger.info(
        { requestId, unavailableCount: unavailableIds.length },
        'Filtering out unavailable therapists'
      );

      // Filter out unavailable therapists and transform for API response
      // NOTE: Email is intentionally NOT included in public API response for privacy
      const response = therapists
        .filter((t) => !unavailableSet.has(t.id))
        .map((t) => ({
          id: t.id,
          name: t.name,
          bio: t.bio,
          // Category system
          approach: t.approach,
          style: t.style,
          areasOfFocus: t.areasOfFocus,
          // email intentionally omitted - not public information
          availability: t.availability,
          active: t.active,
          availabilitySummary: formatAvailabilitySummary(t.availability),
          profileImage: t.profileImage,
          acceptingBookings: true, // Only available therapists are in this list
        }));

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
        // Fetch therapist details and booking status in parallel (both use id from params)
        const [therapist, availabilityStatus] = await Promise.all([
          notionService.getTherapist(id),
          therapistBookingStatusService.canAcceptNewRequest(id, ''),
        ]);

        if (!therapist) {
          return Errors.notFound(reply, 'Therapist');
        }

        const acceptingBookings = availabilityStatus.canAcceptNewRequests;

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
          availability: therapist.availability,
          active: therapist.active,
          availabilitySummary: formatAvailabilitySummary(therapist.availability),
          acceptingBookings,
          profileImage: therapist.profileImage,
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

function formatAvailabilitySummary(availability: Therapist['availability']): string {
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
