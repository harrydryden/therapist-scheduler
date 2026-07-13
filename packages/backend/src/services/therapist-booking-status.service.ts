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
 * Therapist availability under the target-appointment model.
 *
 * See docs/THERAPIST_TARGET_AVAILABILITY.md. Availability is derived
 * DIRECTLY from appointment state + the per-therapist target, so there is a
 * single source of truth and no counter to drift:
 *
 *   live  ==  active
 *         &&  not manually frozen (TherapistBookingStatus.frozenAt is null)
 *         &&  distinct completed clients  <  targetAppointments
 *         &&  no active appointment currently exists (serial)
 *
 * `TherapistBookingStatus` is retained ONLY as the manual-override record:
 * `frozenAt` is set/cleared by the admin /freeze and /unfreeze endpoints.
 * The former auto-freeze counter methods (recordNewRequest, markConfirmed,
 * unmarkConfirmed, recalculateUniqueRequestCount) are now no-ops — their
 * call sites (booking transaction, transition side-effects) are left in
 * place so nothing breaks, but they no longer maintain any state the
 * availability rule reads. A future cleanup can drop the registrations.
 */
class TherapistBookingStatusService {
  /**
   * Resolve a therapist's target from the public handle (legacy notionId or
   * post-Notion Postgres id). Falls back to the config default if the row is
   * missing (shouldn't happen in practice).
   */
  private async resolveTarget(
    client: PrismaClient | TransactionClient,
    therapistHandle: string,
  ): Promise<number> {
    const therapist = await client.therapist.findFirst({
      where: { OR: [{ notionId: therapistHandle }, { id: therapistHandle }] },
      select: { targetAppointments: true },
    });
    if (therapist) return therapist.targetAppointments;
    return getSettingValue<number>('general.defaultTargetAppointments');
  }

  /**
   * Count DISTINCT clients (user_email) the therapist has a `completed`
   * appointment with. Repeat sessions with the same client count once.
   */
  private async countCompletedClients(
    client: PrismaClient | TransactionClient,
    therapistHandle: string,
  ): Promise<number> {
    const rows = await client.appointmentRequest.groupBy({
      by: ['userEmail'],
      where: { therapistHandle, status: 'completed' },
    });
    return rows.length;
  }

  /**
   * Check if a therapist can accept a new appointment request.
   *
   * Order matters:
   *   1. Manual admin freeze overrides everything.
   *   2. Continuation: if THIS client already has an active request, always
   *      allow (don't reject an in-flight negotiation on its own therapist
   *      being "busy").
   *   3. Serial guard: any active appointment (with anyone) blocks new
   *      clients — a therapist handles one client at a time.
   *   4. Target: distinct completed clients >= target → graduated.
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
        select: { frozenAt: true },
      });
      if (status?.frozenAt) {
        return { canAcceptNewRequests: false, reason: 'frozen' };
      }

      // 2. Continuation for the same client.
      if (userEmail) {
        const existingRequest = await client.appointmentRequest.findFirst({
          where: {
            therapistHandle,
            userEmail,
            status: { in: [...ACTIVE_STATUSES] },
          },
          select: { id: true },
        });
        if (existingRequest) {
          return { canAcceptNewRequests: true, reason: 'available' };
        }
      }

      // 3. Serial guard — any active appointment blocks new clients.
      const activeRequest = await client.appointmentRequest.findFirst({
        where: {
          therapistHandle,
          status: { in: [...ACTIVE_STATUSES] },
        },
        select: { id: true },
      });
      if (activeRequest) {
        return { canAcceptNewRequests: false, reason: 'in_session' };
      }

      // 4. Target reached — graduated off the finder.
      const [target, completedClients] = await Promise.all([
        this.resolveTarget(client, therapistHandle),
        this.countCompletedClients(client, therapistHandle),
      ]);
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
   * site: manually frozen OR currently in a session (active appointment) OR
   * at/over their completed-client target. `active = false` (archived) is
   * filtered separately by the public list route.
   *
   * Returns handles (notionId ?? id) so the caller can match against the
   * same key the public listing uses.
   */
  async getUnavailableTherapistIds(): Promise<string[]> {
    try {
      const therapists = await prisma.therapist.findMany({
        select: { id: true, notionId: true, targetAppointments: true },
      });
      if (therapists.length === 0) return [];

      const handleInfo = therapists.map((t) => ({
        handle: t.notionId ?? t.id,
        target: t.targetAppointments,
      }));
      const handles = handleInfo.map((h) => h.handle);

      const [frozenRows, activeRows, completedRows] = await Promise.all([
        // Manual admin freezes.
        prisma.therapistBookingStatus.findMany({
          where: { frozenAt: { not: null }, id: { in: handles } },
          select: { id: true },
        }),
        // Handles with any active appointment.
        prisma.appointmentRequest.findMany({
          where: { therapistHandle: { in: handles }, status: { in: [...ACTIVE_STATUSES] } },
          select: { therapistHandle: true },
          distinct: ['therapistHandle'],
        }),
        // Distinct (handle, client) pairs among completed appointments.
        prisma.appointmentRequest.groupBy({
          by: ['therapistHandle', 'userEmail'],
          where: { therapistHandle: { in: handles }, status: 'completed' },
        }),
      ]);

      const frozenSet = new Set(frozenRows.map((r) => r.id));
      const activeSet = new Set(activeRows.map((r) => r.therapistHandle));
      const completedCount = new Map<string, number>();
      for (const row of completedRows) {
        completedCount.set(
          row.therapistHandle,
          (completedCount.get(row.therapistHandle) ?? 0) + 1,
        );
      }

      const unavailable: string[] = [];
      for (const { handle, target } of handleInfo) {
        const busy = activeSet.has(handle);
        const frozen = frozenSet.has(handle);
        const graduated = (completedCount.get(handle) ?? 0) >= target;
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
   * Previously auto-unfroze therapists whose conversations went inactive.
   * Retired under the target model: `frozenAt` now means a deliberate admin
   * freeze, so auto-clearing it would silently undo admin intent. Stale
   * conversations are surfaced to admins by the appointment-level stale
   * check instead.
   */
  async checkAndHandleInactiveTherapists(
    _inactivityThreshold: Date,
  ): Promise<{ flaggedCount: number; unfrozenCount: number }> {
    return { flaggedCount: 0, unfrozenCount: 0 };
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
