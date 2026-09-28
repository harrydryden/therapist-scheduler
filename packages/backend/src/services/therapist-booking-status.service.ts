import { prisma } from '../utils/database';
import { Prisma } from '@prisma/client';
import { logger } from '../utils/logger';
import { ACTIVE_STATUSES } from '../constants';
import { getSettingValue } from './settings.service';

// Type for transaction client
type TransactionClient = Prisma.TransactionClient;
type PrismaClient = typeof prisma;

export interface TherapistAvailabilityStatus {
  canAcceptNewRequests: boolean;
  // 'available'      → live and bookable
  // 'frozen'         → manual admin freeze in effect
  // 'in_session'     → serial guard: therapist already has an active appt
  // 'target_reached' → completed distinct-client target; graduated off finder
  // 'error_fallback' → an error occurred; fail open (allow) but flag it
  reason?: 'available' | 'frozen' | 'in_session' | 'target_reached' | 'error_fallback';
}

/**
 * An appointment that holds the therapist: an active status AND a verified
 * requester. A booking request whose email address has not been verified
 * yet (`emailVerifiedAt` null — see the AppointmentRequest schema comment)
 * must not mark the therapist in session: one unverified request per
 * therapist would otherwise empty the public finder (review §3 #3). Rows
 * that predate verification were backfilled to their createdAt.
 */
const HOLDS_THERAPIST = {
  status: { in: [...ACTIVE_STATUSES] },
  emailVerifiedAt: { not: null },
} satisfies Prisma.AppointmentRequestWhereInput;

/**
 * Therapist availability under the target-appointment model.
 *
 * See docs/THERAPIST_TARGET_AVAILABILITY.md. A therapist is live iff:
 *
 *   live  ==  active
 *         &&  not manually frozen (TherapistBookingStatus.manualFreezeAt is null)
 *         &&  distinct completed clients  <  targetAppointments
 *         &&  no active, email-verified appointment currently exists (serial)
 *
 * "Distinct completed clients" is read from `therapist_completed_clients`,
 * the durable record written atomically with every transition to
 * `completed` (domain/scheduling/lifecycle/completed-clients.ts). It used to
 * be `COUNT(DISTINCT lower(user_email)) … WHERE status='completed'` over
 * appointment rows, which retention hard-deletes after a year and admins can
 * delete at any time — so a graduated therapist silently reappeared on the
 * finder (review §3 #4). The table is unique per (therapist, client-email
 * hash), so repeat sessions with the same client count once, and the hash
 * is of the lowercased address, so 'Alice@x.com' and 'alice@x.com' are one
 * client.
 *
 * `TherapistBookingStatus` is retained ONLY as the manual-override record:
 * `manualFreezeAt` is set/cleared by the admin /freeze and /unfreeze
 * endpoints. We deliberately read `manualFreezeAt` and NOT the legacy
 * `frozenAt` — the retired auto-freeze set `frozenAt` on every booking
 * request, so reading it would hide every recently-booked therapist at
 * cutover (see docs/THERAPIST_TARGET_AVAILABILITY.md, "cutover safety").
 * The former auto-freeze counter methods (recordNewRequest, markConfirmed,
 * unmarkConfirmed, recalculateUniqueRequestCount) are no-ops kept for their
 * remaining call sites.
 */
class TherapistBookingStatusService {
  /**
   * Target + distinct completed-client count for one public handle
   * (legacy notionId or post-Notion Postgres id), in one query. Falls back
   * to the configured default target (and zero completions) when no
   * Therapist row matches the handle.
   */
  private async graduationInfo(
    client: PrismaClient | TransactionClient,
    therapistHandle: string,
  ): Promise<{ target: number; completedClients: number }> {
    const therapist = await client.therapist.findFirst({
      where: { OR: [{ notionId: therapistHandle }, { id: therapistHandle }] },
      select: { targetAppointments: true, _count: { select: { completedClients: true } } },
    });
    if (therapist) {
      return {
        target: therapist.targetAppointments,
        completedClients: therapist._count.completedClients,
      };
    }
    return {
      target: await getSettingValue<number>('general.defaultTargetAppointments'),
      completedClients: 0,
    };
  }

  /**
   * Public: distinct completed-client count for a single therapist handle.
   * Used by the admin detail route so the "Completed" figure and the
   * availability rule agree.
   */
  async getCompletedClientCount(therapistHandle: string): Promise<number> {
    const { completedClients } = await this.graduationInfo(prisma, therapistHandle);
    return completedClients;
  }

  /**
   * Public: distinct completed-client counts for many handles in one query.
   * Single source of truth for the "Completed" column and the availability
   * `graduated` check — keeps the admin list, the finder, and the booking
   * gate from diverging. Keyed by whichever form of the handle the caller
   * passed (notionId or id).
   */
  async getCompletedClientCounts(handles: string[]): Promise<Map<string, number>> {
    const map = new Map<string, number>();
    if (handles.length === 0) return map;
    const wanted = new Set(handles);
    const therapists = await prisma.therapist.findMany({
      where: { OR: [{ notionId: { in: handles } }, { id: { in: handles } }] },
      select: { id: true, notionId: true, _count: { select: { completedClients: true } } },
    });
    for (const t of therapists) {
      const count = t._count.completedClients;
      if (t.notionId && wanted.has(t.notionId)) map.set(t.notionId, count);
      if (wanted.has(t.id)) map.set(t.id, count);
    }
    return map;
  }

  /**
   * Check if a therapist can accept a new appointment request.
   *
   * Order matters:
   *   1. Manual admin freeze overrides everything.
   *   2. Continuation: if THIS client already has an active, verified
   *      request, always allow (don't reject an in-flight negotiation on its
   *      own therapist being "busy").
   *   3. Serial guard: any active, verified appointment (with anyone) blocks
   *      new clients — a therapist handles one client at a time.
   *   4. Target: distinct completed clients >= target → graduated.
   *
   * Unverified requests are invisible to 2 and 3: they neither hold the
   * therapist nor vouch for a continuation (otherwise a requester verifying
   * late would be waved through by their own unverified row while another
   * client holds the therapist).
   *
   * @param tx - Optional transaction client for read-your-write consistency
   *             inside the booking transaction.
   */
  async canAcceptNewRequest(
    therapistHandle: string,
    userEmail: string,
    tx?: TransactionClient,
  ): Promise<TherapistAvailabilityStatus> {
    const client: PrismaClient | TransactionClient = tx || prisma;

    try {
      // 1. Manual admin freeze.
      const status = await client.therapistBookingStatus.findUnique({
        where: { id: therapistHandle },
        select: { manualFreezeAt: true },
      });
      if (status?.manualFreezeAt) {
        return { canAcceptNewRequests: false, reason: 'frozen' };
      }

      // 2. Continuation for the same client.
      if (userEmail) {
        const existingRequest = await client.appointmentRequest.findFirst({
          where: { therapistHandle, userEmail, ...HOLDS_THERAPIST },
          select: { id: true },
        });
        if (existingRequest) {
          return { canAcceptNewRequests: true, reason: 'available' };
        }
      }

      // 3. Serial guard — any active, verified appointment blocks new clients.
      const activeRequest = await client.appointmentRequest.findFirst({
        where: { therapistHandle, ...HOLDS_THERAPIST },
        select: { id: true },
      });
      if (activeRequest) {
        return { canAcceptNewRequests: false, reason: 'in_session' };
      }

      // 4. Target reached — graduated off the finder.
      const { target, completedClients } = await this.graduationInfo(client, therapistHandle);
      if (completedClients >= target) {
        return { canAcceptNewRequests: false, reason: 'target_reached' };
      }

      return { canAcceptNewRequests: true, reason: 'available' };
    } catch (error) {
      logger.error(
        {
          error,
          therapistHandle,
          userEmail,
          operation: 'canAcceptNewRequest',
          inTransaction: !!tx,
        },
        'Failed to check therapist availability',
      );
      // Fail open (allow) so a transient DB error doesn't block all bookings,
      // but use a distinct reason so it isn't mistaken for genuine availability.
      return { canAcceptNewRequests: true, reason: 'error_fallback' };
    }
  }

  /**
   * Compute the set of therapist handles that are NOT live on the public
   * site: manually frozen OR currently in a session (active, verified
   * appointment) OR at/over their completed-client target. `active = false`
   * (archived) is filtered separately by the public list route.
   *
   * Returns handles (notionId ?? id) so the caller can match against the
   * same key the public listing uses.
   */
  async getUnavailableTherapistIds(): Promise<string[]> {
    try {
      const therapists = await prisma.therapist.findMany({
        select: {
          id: true,
          notionId: true,
          targetAppointments: true,
          _count: { select: { completedClients: true } },
        },
      });
      if (therapists.length === 0) return [];

      const handleInfo = therapists.map((t) => ({
        handle: t.notionId ?? t.id,
        target: t.targetAppointments,
        completedClients: t._count.completedClients,
      }));
      const handles = handleInfo.map((h) => h.handle);

      const [frozenRows, activeRows] = await Promise.all([
        // Manual admin freezes.
        prisma.therapistBookingStatus.findMany({
          where: { manualFreezeAt: { not: null }, id: { in: handles } },
          select: { id: true },
        }),
        // Handles held by an active, verified appointment.
        prisma.appointmentRequest.findMany({
          where: { therapistHandle: { in: handles }, ...HOLDS_THERAPIST },
          select: { therapistHandle: true },
          distinct: ['therapistHandle'],
        }),
      ]);

      const frozenSet = new Set(frozenRows.map((r) => r.id));
      const activeSet = new Set(activeRows.map((r) => r.therapistHandle));

      const unavailable: string[] = [];
      for (const { handle, target, completedClients } of handleInfo) {
        const busy = activeSet.has(handle);
        const frozen = frozenSet.has(handle);
        const graduated = completedClients >= target;
        if (busy || frozen || graduated) {
          unavailable.push(handle);
        }
      }

      logger.debug(
        { total: handles.length, unavailable: unavailable.length },
        'Computed unavailable therapist handles (target model)',
      );
      return unavailable;
    } catch (error) {
      logger.error(
        { error, operation: 'getUnavailableTherapistIds' },
        'Failed to compute unavailable therapist IDs',
      );
      return [];
    }
  }

  // ---------------------------------------------------------------------------
  // No-op compatibility shims.
  //
  // The target model derives availability from appointment state directly,
  // so these former counter-maintenance methods no longer do anything. They
  // are kept callable so existing call sites (booking transaction, transition
  // side-effects, admin appointment create/delete) don't need to change and
  // their side-effect-retry rows still complete. See the class doc.
  // ---------------------------------------------------------------------------

  async recordNewRequest(
    _therapistHandle: string,
    _therapistName: string,
    _userEmail: string,
    _tx?: TransactionClient,
  ): Promise<void> {
    // No-op: the freshly-created appointment (an ACTIVE status) is what makes
    // canAcceptNewRequest reject other clients now.
  }

  async markConfirmed(_therapistHandle: string, _therapistName: string): Promise<void> {
    // No-op: a `confirmed` appointment is an ACTIVE status, so the serial
    // guard already treats the therapist as unavailable.
  }

  async unmarkConfirmed(_therapistHandle: string): Promise<void> {
    // No-op: availability re-derives from appointment state once the booking
    // leaves ACTIVE statuses (completed/cancelled).
  }

  async recalculateUniqueRequestCount(_therapistHandle: string): Promise<void> {
    // No-op: no counter to recalculate under the target model.
  }

  /**
   * Get therapists flagged for admin attention. Retained for the admin
   * monitoring route; returns [] in practice now that the target model no
   * longer sets adminAlertAt.
   */
  async getFlaggedTherapists(): Promise<
    Array<{
      id: string;
      therapistName: string;
      adminAlertAt: Date;
      uniqueRequestCount: number;
    }>
  > {
    try {
      const flagged = await prisma.therapistBookingStatus.findMany({
        where: {
          adminAlertAt: { not: null },
          adminAlertAcknowledged: false,
        },
        select: {
          id: true,
          therapistName: true,
          adminAlertAt: true,
          uniqueRequestCount: true,
        },
      });

      return flagged.map((t) => ({
        id: t.id,
        therapistName: t.therapistName,
        adminAlertAt: t.adminAlertAt!,
        uniqueRequestCount: t.uniqueRequestCount,
      }));
    } catch (error) {
      logger.error({ error }, 'Failed to get flagged therapists');
      return [];
    }
  }

  /**
   * Acknowledge a flagged therapist (admin action).
   */
  async acknowledgeFlaggedTherapist(therapistHandle: string): Promise<void> {
    try {
      await prisma.therapistBookingStatus.update({
        where: { id: therapistHandle },
        data: { adminAlertAcknowledged: true },
      });

      logger.info({ therapistHandle }, 'Admin acknowledged flagged therapist');
    } catch (error) {
      logger.error({ error, therapistHandle }, 'Failed to acknowledge flagged therapist');
      throw error;
    }
  }
}

export const therapistBookingStatusService = new TherapistBookingStatusService();
