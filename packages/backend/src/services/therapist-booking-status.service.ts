import { prisma } from '../utils/database';
import { Prisma } from '@prisma/client';
import { logger } from '../utils/logger';
import { sleep } from '../utils/timeout';
import { PRE_BOOKING_STATUSES, CONFIRMED_ACTIVE_STATUSES, ACTIVE_STATUSES } from '../constants';
import { getSettingValue } from './settings.service';
import { isTherapistPending } from './stage-groups';

// Type for transaction client
type TransactionClient = Prisma.TransactionClient;
type PrismaClient = typeof prisma;

// FIX M9: Retry configuration for serialization failures
const SERIALIZATION_RETRY = {
  MAX_RETRIES: 3,
  BASE_DELAY_MS: 50,
  MAX_DELAY_MS: 500,
  JITTER_FACTOR: 0.2,
};

/**
 * Calculate exponential backoff delay with jitter
 */
function getBackoffDelay(attempt: number): number {
  const baseDelay = SERIALIZATION_RETRY.BASE_DELAY_MS * Math.pow(2, attempt);
  const cappedDelay = Math.min(baseDelay, SERIALIZATION_RETRY.MAX_DELAY_MS);
  const jitter = cappedDelay * SERIALIZATION_RETRY.JITTER_FACTOR * Math.random();
  return cappedDelay + jitter;
}

/**
 * Check if error is a serialization failure
 */
function isSerializationError(error: unknown): boolean {
  return error instanceof Error && (
    error.message.includes('could not serialize') ||
    (error as any).code === 'P2034'
  );
}

export interface TherapistAvailabilityStatus {
  canAcceptNewRequests: boolean;
  // FIX L3: Added 'error_fallback' to distinguish error cases from normal availability
  reason?: 'confirmed' | 'frozen' | 'available' | 'error_fallback';
  frozenUntil?: Date;
}

class TherapistBookingStatusService {
  /**
   * Check if a therapist can accept new appointment requests
   *
   * Logic:
   * - If therapist has confirmed booking: reject
   * - If user already has an active request: allow (continuation)
   * - If 2+ unique users: reject (fully frozen)
   * - If 1 unique user and <36h since last activity: reject (frozen for new users)
   * - If 1 unique user and >=36h since last activity: allow (opens for second user)
   *
   * @param tx - Optional transaction client for atomic operations (IMPORTANT for race condition prevention)
   */
  async canAcceptNewRequest(
    therapistHandle: string,
    userEmail: string,
    tx?: TransactionClient
  ): Promise<TherapistAvailabilityStatus> {
    const client: PrismaClient | TransactionClient = tx || prisma;
    const maxRequests = await getSettingValue<number>('general.maxBookingRequestsPerTherapist');

    try {
      const status = await client.therapistBookingStatus.findUnique({
        where: { id: therapistHandle },
      });

      // If no status record exists, therapist can accept requests
      if (!status) {
        return { canAcceptNewRequests: true, reason: 'available' };
      }

      // If therapist has a confirmed booking, reject new requests
      if (status.hasConfirmedBooking) {
        return { canAcceptNewRequests: false, reason: 'confirmed' };
      }

      // Check if user already has an active request (always allow continuation)
      const existingRequest = await client.appointmentRequest.findFirst({
        where: {
          therapistHandle,
          userEmail,
          status: { in: [...ACTIVE_STATUSES] },
        },
        select: { id: true },
      });

      if (existingRequest) {
        // User already has an active request, allow them to continue
        return { canAcceptNewRequests: true, reason: 'available' };
      }

      // Already at max unique requests - fully frozen
      if (status.uniqueRequestCount >= maxRequests) {
        return {
          canAcceptNewRequests: false,
          reason: 'frozen',
        };
      }

      // Only 1 request so far - check if 36h passed on that thread
      if (status.uniqueRequestCount === 1) {
        // Any active request = frozen. Stale conversations are flagged for admin attention
        // instead of auto-unfreezing. Admin can manually unfreeze via dashboard.
        const activeRequest = await client.appointmentRequest.findFirst({
          where: {
            therapistHandle,
            status: { in: [...ACTIVE_STATUSES] },
          },
          select: { id: true },
        });

        if (activeRequest) {
          return {
            canAcceptNewRequests: false,
            reason: 'frozen',
          };
        }
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
        'Failed to check therapist availability'
      );
      // FIX L3: On error, allow the request to proceed (fail open) but use distinct reason
      // This prevents the error from being masked as a normal "available" state
      return { canAcceptNewRequests: true, reason: 'error_fallback' };
    }
  }

  /**
   * Record a new appointment request and update therapist status
   * Freezes therapist immediately on first request
   *
   * IMPORTANT: Uses transaction with serializable isolation to prevent race condition
   * where concurrent requests could result in incorrect uniqueRequestCount.
   *
   * TRADEOFF: Serializable isolation can cascade under high concurrency. An alternative
   * is RepeatableRead + SELECT ... FOR UPDATE (row-level locks), which provides equivalent
   * guarantees with less contention. Kept as Serializable since current traffic levels
   * are well within the retry budget (3 retries, 50-500ms backoff).
   *
   * @param tx - Optional transaction client for atomic operations
   */
  async recordNewRequest(
    therapistHandle: string,
    therapistName: string,
    userEmail: string,
    tx?: TransactionClient
  ): Promise<void> {
    // If already in a transaction, use it directly
    if (tx) {
      await this.recordNewRequestInner(tx, therapistHandle, therapistName, userEmail);
      return;
    }

    // Otherwise, wrap in a new transaction with serializable isolation
    // to prevent race conditions when counting unique emails
    // FIX M9: Use exponential backoff for serialization retry
    let lastError: unknown = null;
    for (let attempt = 0; attempt <= SERIALIZATION_RETRY.MAX_RETRIES; attempt++) {
      try {
        await prisma.$transaction(
          async (txClient) => {
            await this.recordNewRequestInner(txClient, therapistHandle, therapistName, userEmail);
          },
          {
            // Serializable isolation prevents race conditions by ensuring
            // the count + upsert happens atomically
            isolationLevel: 'Serializable',
            maxWait: 5000, // 5 seconds
            timeout: 10000, // 10 seconds
          }
        );
        return; // Success - exit the retry loop
      } catch (error) {
        lastError = error;
        if (isSerializationError(error) && attempt < SERIALIZATION_RETRY.MAX_RETRIES) {
          const delay = getBackoffDelay(attempt);
          logger.warn(
            { therapistHandle, userEmail, attempt: attempt + 1, delayMs: delay },
            'Serialization conflict in recordNewRequest - retrying with backoff'
          );
          await sleep(delay);
          continue;
        }
        // Non-serialization error or max retries exceeded
        break;
      }
    }

    // FIX N3: Propagate error after retry exhaustion instead of silently failing
    // Silent failure could lead to:
    // 1. Therapist not being frozen when they should be
    // 2. Incorrect uniqueRequestCount
    // 3. Caller thinking operation succeeded
    logger.error(
      { error: lastError, therapistHandle, userEmail, operation: 'recordNewRequest', retries: SERIALIZATION_RETRY.MAX_RETRIES },
      'Failed to record new request after retries - propagating error'
    );
    throw lastError;
  }

  /**
   * Inner implementation of recordNewRequest - must be called within a transaction
   */
  private async recordNewRequestInner(
    client: TransactionClient,
    therapistHandle: string,
    therapistName: string,
    userEmail: string
  ): Promise<void> {
    // Count unique email addresses with active (non-terminal) requests for this therapist.
    // Only ACTIVE_STATUSES are counted so that completed appointments don't inflate the
    // count and incorrectly freeze the therapist for new bookings.
    const uniqueEmails = await client.appointmentRequest.groupBy({
      by: ['userEmail'],
      where: {
        therapistHandle,
        status: { in: [...ACTIVE_STATUSES] },
      },
    });

    // Include the new request email
    const emailSet = new Set(uniqueEmails.map((e) => e.userEmail));
    emailSet.add(userEmail);
    const uniqueCount = emailSet.size;

    const now = new Date();

    await client.therapistBookingStatus.upsert({
      where: { id: therapistHandle },
      create: {
        id: therapistHandle,
        therapistName,
        uniqueRequestCount: uniqueCount,
        frozenAt: now, // Always freeze on first request
        frozenUntil: null, // No time-based unfreeze
      },
      update: {
        therapistName,
        uniqueRequestCount: uniqueCount,
        frozenAt: now,
        // Reset admin alert flags on new activity
        adminAlertAt: null,
        adminAlertAcknowledged: false,
      },
    });

    logger.info(
      { therapistHandle, therapistName, uniqueCount, userEmail },
      'Therapist frozen due to new request'
    );
  }

  /**
   * Mark a therapist as having a confirmed booking
   */
  async markConfirmed(therapistHandle: string, therapistName: string): Promise<void> {
    try {
      await prisma.therapistBookingStatus.upsert({
        where: { id: therapistHandle },
        create: {
          id: therapistHandle,
          therapistName,
          hasConfirmedBooking: true,
          confirmedAt: new Date(),
        },
        update: {
          therapistName,
          hasConfirmedBooking: true,
          confirmedAt: new Date(),
        },
      });

      logger.info(
        { therapistHandle, therapistName },
        'Therapist marked as having confirmed booking'
      );
    } catch (error) {
      logger.error({ error, therapistHandle }, 'Failed to mark therapist as confirmed');
      // Propagate error so caller knows the freeze failed
      throw error;
    }
  }

  /**
   * Get all therapists that should be hidden from the frontend.
   *
   * Postgres `therapistBookingStatus` is the single source of truth: rows
   * are written inside the appointment-creation transaction, so freezes
   * take effect immediately. The previous Notion-Frozen-checkbox check has
   * been retired with PR 2 of the Notion deprecation.
   */
  async getUnavailableTherapistIds(): Promise<string[]> {
    try {
      const frozen = await this.getFrozenTherapistIdsFromPostgres();
      logger.debug({ count: frozen.length }, 'Retrieved frozen therapist IDs from Postgres');
      return frozen;
    } catch (error) {
      logger.error({ error, operation: 'getUnavailableTherapistIds' }, 'Failed to get unavailable therapist IDs');
      return [];
    }
  }

  /**
   * Get therapist IDs that should be frozen based on Postgres booking status.
   * This is the authoritative source — updated inside the appointment creation transaction.
   * Delegates to batchComputeFreezeStatus to avoid duplicating freeze logic.
   */
  private async getFrozenTherapistIdsFromPostgres(): Promise<string[]> {
    try {
      const statuses = await prisma.therapistBookingStatus.findMany({
        select: { id: true },
      });

      if (statuses.length === 0) return [];

      const therapistIds = statuses.map(s => s.id);
      const freezeMap = await this.batchComputeFreezeStatus(therapistIds);

      return therapistIds.filter(id => freezeMap.get(id) === true);
    } catch (error) {
      logger.error({ error, operation: 'getFrozenTherapistIdsFromPostgres' }, 'Failed to get frozen IDs from Postgres');
      return [];
    }
  }

  /**
   * Batch compute freeze status for multiple therapists
   * Optimized: Uses 2 queries total instead of N+1
   *
   * @param therapistIds - Array of therapist handles to check
   * @returns Map of therapistHandle → shouldBeFrozen
   */
  async batchComputeFreezeStatus(therapistIds: string[]): Promise<Map<string, boolean>> {
    const result = new Map<string, boolean>();

    if (therapistIds.length === 0) {
      return result;
    }

    try {
      // Query 1: Get all booking statuses for these therapists
      const statuses = await prisma.therapistBookingStatus.findMany({
        where: { id: { in: therapistIds } },
        select: {
          id: true,
          hasConfirmedBooking: true,
          frozenAt: true,
        },
      });

      // Build map of status by ID
      const statusMap = new Map(statuses.map(s => [s.id, s]));

      // Find therapist IDs that need confirmed appointment check (hasConfirmedBooking not set)
      const needsConfirmedCheck = statuses
        .filter(s => !s.hasConfirmedBooking)
        .map(s => s.id);

      // Find therapist IDs that have frozenAt but not hasConfirmedBooking
      // These need the pre-booking active appointment check
      const needsActiveCheck = statuses
        .filter(s => s.frozenAt && !s.hasConfirmedBooking)
        .map(s => s.id);

      // Query 2: Defense-in-depth — find therapists with confirmed+ appointments
      // even if hasConfirmedBooking flag wasn't set (e.g. markConfirmed failed)
      const therapistsWithConfirmedAppointments = new Set<string>();
      if (needsConfirmedCheck.length > 0) {
        const confirmedAppointments = await prisma.appointmentRequest.findMany({
          where: {
            therapistHandle: { in: needsConfirmedCheck },
            status: { in: [...CONFIRMED_ACTIVE_STATUSES] },
          },
          select: { therapistHandle: true },
          distinct: ['therapistHandle'],
        });
        confirmedAppointments.forEach(a => therapistsWithConfirmedAppointments.add(a.therapistHandle));
      }

      // Query 3: Get therapists with active pre-booking conversations (single query)
      const therapistsWithActiveConversations = new Set<string>();
      if (needsActiveCheck.length > 0) {
        const activeAppointments = await prisma.appointmentRequest.findMany({
          where: {
            therapistHandle: { in: needsActiveCheck },
            status: { in: [...PRE_BOOKING_STATUSES] },
          },
          select: { therapistHandle: true },
          distinct: ['therapistHandle'],
        });
        activeAppointments.forEach(a => therapistsWithActiveConversations.add(a.therapistHandle));
      }

      // Compute freeze status for each therapist
      for (const therapistId of therapistIds) {
        const status = statusMap.get(therapistId);

        if (!status) {
          result.set(therapistId, false); // No booking activity = not frozen
          continue;
        }

        if (status.hasConfirmedBooking) {
          result.set(therapistId, true); // Confirmed booking = always frozen
          continue;
        }

        // Defense-in-depth: confirmed+ appointment exists but flag not set
        if (therapistsWithConfirmedAppointments.has(therapistId)) {
          result.set(therapistId, true);
          continue;
        }

        if (status.frozenAt && therapistsWithActiveConversations.has(therapistId)) {
          result.set(therapistId, true); // Frozen with active conversation
          continue;
        }

        result.set(therapistId, false);
      }

      return result;
    } catch (error) {
      logger.error({ error, count: therapistIds.length }, 'Failed to batch compute freeze status');
      // Fail-open: on error, assume not frozen rather than blocking all therapists
      for (const id of therapistIds) {
        result.set(id, false);
      }
      return result;
    }
  }

  /**
   * Unified handler for inactive therapists:
   * 1. Flags therapists for admin attention (2+ threads all inactive)
   * 2. Auto-unfreezes therapists with inactive conversations (clears freeze status)
   *
   * This simplified model uses a single inactivity threshold for both actions.
   * When conversations are inactive beyond the threshold:
   * - Admin gets notified via flagging
   * - Therapist is automatically unfrozen so they can accept new requests
   *
   * @param inactivityThreshold - Date threshold for considering conversations inactive
   * @returns Object with flaggedCount and unfrozenCount
   */
  async checkAndHandleInactiveTherapists(
    inactivityThreshold: Date
  ): Promise<{ flaggedCount: number; unfrozenCount: number }> {
    const now = new Date();
    let flaggedCount = 0;
    let unfrozenCount = 0;

    const maxReqs = await getSettingValue<number>('general.maxBookingRequestsPerTherapist');

    try {
      // 1. Flag therapists with max+ threads where ALL are inactive
      // These need admin attention (might want to cancel stale conversations)
      const preBookingStatuses = PRE_BOOKING_STATUSES as readonly string[];
      const flaggedResult = await prisma.$executeRaw`
        UPDATE therapist_booking_status tbs
        SET admin_alert_at = ${now}, updated_at = ${now}
        WHERE tbs.has_confirmed_booking = false
          AND tbs.unique_request_count >= ${maxReqs}
          AND tbs.admin_alert_at IS NULL
          AND EXISTS (
            SELECT 1 FROM appointment_requests ar
            WHERE ar.therapist_handle = tbs.id
              AND ar.status IN (${Prisma.join(preBookingStatuses)})
          )
          AND NOT EXISTS (
            SELECT 1 FROM appointment_requests ar
            WHERE ar.therapist_handle = tbs.id
              AND ar.status IN (${Prisma.join(preBookingStatuses)})
              AND ar.last_activity_at IS NOT NULL
              AND ar.last_activity_at >= ${inactivityThreshold}
          )
      `;
      flaggedCount = Number(flaggedResult);

      // 2. Auto-unfreeze therapists where ALL active conversations are inactive
      // Find therapists to unfreeze (single active thread that's been inactive)
      const therapistsToUnfreeze = await prisma.therapistBookingStatus.findMany({
        where: {
          hasConfirmedBooking: false,
          frozenAt: { not: null },
          // Only consider those with active (non-confirmed) conversations
          uniqueRequestCount: { gte: 1 },
        },
        select: { id: true, therapistName: true },
      });

      if (therapistsToUnfreeze.length > 0) {
        // PERF: Batch query all active conversations for candidate therapists (avoids N+1)
        const therapistIds = therapistsToUnfreeze.map(t => t.id);
        const allActiveConversations = await prisma.appointmentRequest.findMany({
          where: {
            therapistHandle: { in: therapistIds },
            status: { in: [...PRE_BOOKING_STATUSES] },
          },
          select: { therapistHandle: true, lastActivityAt: true, checkpointStage: true },
        });

        // Group conversations by therapist
        const conversationsByTherapist = new Map<
          string,
          Array<{ lastActivityAt: Date | null; checkpointStage: string | null }>
        >();
        for (const conv of allActiveConversations) {
          const existing = conversationsByTherapist.get(conv.therapistHandle) || [];
          existing.push({
            lastActivityAt: conv.lastActivityAt,
            checkpointStage: conv.checkpointStage,
          });
          conversationsByTherapist.set(conv.therapistHandle, existing);
        }

        // Collect IDs to unfreeze in bulk
        const idsToUnfreeze: string[] = [];

        for (const therapist of therapistsToUnfreeze) {
          const conversations = conversationsByTherapist.get(therapist.id);

          // If no active conversations, skip (already handled by other flows)
          if (!conversations || conversations.length === 0) continue;

          // Skip if ANY conversation is awaiting a response from THIS
          // therapist. The conversation may look stale on lastActivityAt
          // alone (we sent a chase a week ago and they haven't replied),
          // but it isn't abandoned — we still expect a reply that has
          // to land on a frozen therapist or we'll double-book them.
          // Previous behaviour treated all stale conversations as
          // abandoned, which prematurely unfroze therapists who were
          // just slow to respond.
          const awaitingTherapist = conversations.some((conv) => isTherapistPending(conv.checkpointStage));
          if (awaitingTherapist) continue;

          // Check if ALL are inactive (no activity after threshold)
          const allInactive = conversations.every(
            (conv) => !conv.lastActivityAt || conv.lastActivityAt < inactivityThreshold
          );

          if (allInactive) {
            idsToUnfreeze.push(therapist.id);

            logger.info(
              { therapistId: therapist.id, therapistName: therapist.therapistName },
              'Auto-unfroze therapist due to conversation inactivity'
            );
          }
        }

        // Batch update all therapists to unfreeze
        if (idsToUnfreeze.length > 0) {
          await prisma.therapistBookingStatus.updateMany({
            where: { id: { in: idsToUnfreeze } },
            data: {
              frozenAt: null,
              updatedAt: now,
            },
          });
          unfrozenCount = idsToUnfreeze.length;
        }
      }

      if (flaggedCount > 0) {
        logger.warn(
          { flaggedCount },
          'Flagged therapists for admin attention due to inactive threads'
        );
      }
      if (unfrozenCount > 0) {
        logger.info(
          { unfrozenCount },
          'Auto-unfroze therapists due to conversation inactivity'
        );
      }

      return { flaggedCount, unfrozenCount };
    } catch (error) {
      logger.error(
        { error, operation: 'checkAndHandleInactiveTherapists' },
        'Failed to handle inactive therapists'
      );
      throw error;
    }
  }

  /**
   * Get therapists flagged for admin attention
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
   * Acknowledge a flagged therapist (admin action)
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

  /**
   * Get status for all therapists (for admin dashboard)
   *
   * OPTIMIZED: Uses single query with LEFT JOIN instead of N+1 pattern
   */
  async getAllStatuses(): Promise<
    Array<{
      id: string;
      therapistName: string;
      hasConfirmedBooking: boolean;
      isFrozen: boolean;
      frozenUntil: Date | null;
      uniqueRequestCount: number;
      adminAlertAt: Date | null;
      adminAlertAcknowledged: boolean;
    }>
  > {
    try {
      // Simplified frozen logic: frozen if frozenAt is set (auto-unfreeze clears it)
      const results = await prisma.$queryRaw<
        Array<{
          id: string;
          therapist_name: string;
          has_confirmed_booking: boolean;
          is_frozen: boolean;
          frozen_until: Date | null;
          unique_request_count: number;
          admin_alert_at: Date | null;
          admin_alert_acknowledged: boolean;
        }>
      >`
        SELECT
          tbs.id,
          tbs.therapist_name,
          tbs.has_confirmed_booking,
          tbs.frozen_until,
          tbs.unique_request_count,
          tbs.admin_alert_at,
          tbs.admin_alert_acknowledged,
          CASE
            WHEN tbs.has_confirmed_booking = true THEN true
            WHEN EXISTS (
              SELECT 1 FROM appointment_requests ar
              WHERE ar.therapist_handle = tbs.id
                AND ar.status IN ('confirmed', 'session_held', 'feedback_requested')
            ) THEN true
            WHEN tbs.frozen_at IS NOT NULL AND EXISTS (
              SELECT 1 FROM appointment_requests ar
              WHERE ar.therapist_handle = tbs.id
                AND ar.status IN ('pending', 'contacted', 'negotiating')
            ) THEN true
            ELSE false
          END as is_frozen
        FROM therapist_booking_status tbs
        ORDER BY tbs.updated_at DESC
      `;

      return results.map((r) => ({
        id: r.id,
        therapistName: r.therapist_name,
        hasConfirmedBooking: r.has_confirmed_booking,
        isFrozen: r.is_frozen,
        frozenUntil: r.frozen_until,
        uniqueRequestCount: r.unique_request_count,
        adminAlertAt: r.admin_alert_at,
        adminAlertAcknowledged: r.admin_alert_acknowledged,
      }));
    } catch (error) {
      logger.error({ error }, 'Failed to get all therapist statuses');
      return [];
    }
  }

  /**
   * Recalculate uniqueRequestCount for a therapist after deletion/cancellation
   * Should be called whenever an appointment is deleted or cancelled
   *
   * IMPORTANT: Uses Serializable transaction to prevent race conditions
   * when multiple cancellations happen concurrently.
   */
  async recalculateUniqueRequestCount(therapistHandle: string): Promise<void> {
    const MAX_ATTEMPTS = 2;
    let lastError: unknown = null;
    const maxReqsThreshold = await getSettingValue<number>('general.maxBookingRequestsPerTherapist');

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      try {
        await prisma.$transaction(
          async (tx) => {
            // Count unique email addresses with active (non-terminal) requests.
            // Uses ACTIVE_STATUSES so completed/cancelled appointments don't keep
            // the booking status record alive with a stale frozenAt.
            const uniqueEmails = await tx.appointmentRequest.groupBy({
              by: ['userEmail'],
              where: {
                therapistHandle,
                status: { in: [...ACTIVE_STATUSES] },
              },
            });

            const uniqueCount = uniqueEmails.length;

            // Check if status record exists
            const status = await tx.therapistBookingStatus.findUnique({
              where: { id: therapistHandle },
            });

            if (!status) {
              // No status record means therapist was never booked - nothing to update
              return;
            }

            // If count is 0, we can delete the status record (therapist fully available)
            if (uniqueCount === 0) {
              await tx.therapistBookingStatus.delete({
                where: { id: therapistHandle },
              });
              logger.info(
                { therapistHandle },
                'Removed therapist booking status - no active requests remaining'
              );
              return;
            }

            // Update the count
            await tx.therapistBookingStatus.update({
              where: { id: therapistHandle },
              data: {
                uniqueRequestCount: uniqueCount,
                // Reset admin alert if count drops below threshold
                ...(uniqueCount < maxReqsThreshold && {
                  adminAlertAt: null,
                  adminAlertAcknowledged: false,
                }),
              },
            });

            logger.info(
              { therapistHandle, uniqueCount },
              'Recalculated unique request count for therapist'
            );
          },
          {
            isolationLevel: 'Serializable',
            maxWait: 5000,
            timeout: 10000,
          }
        );
        return; // Success
      } catch (error) {
        lastError = error;
        if (isSerializationError(error) && attempt < MAX_ATTEMPTS - 1) {
          const delay = getBackoffDelay(attempt);
          logger.warn(
            { therapistHandle, attempt: attempt + 1, delayMs: delay },
            'Serialization conflict in recalculateUniqueRequestCount - retrying with backoff'
          );
          await sleep(delay);
          continue;
        }
        break;
      }
    }

    logger.error(
      { error: lastError, therapistHandle, operation: 'recalculateUniqueRequestCount' },
      'Failed to recalculate unique request count'
    );
  }

  /**
   * Unmark a therapist as having a confirmed booking
   * Should be called when a confirmed appointment is cancelled
   * Uses Serializable transaction to prevent race conditions where another
   * appointment is confirmed between our check and update
   */
  async unmarkConfirmed(therapistHandle: string): Promise<void> {
    const MAX_ATTEMPTS = 2;
    let lastError: unknown = null;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      try {
        await prisma.$transaction(
          async (tx) => {
            const status = await tx.therapistBookingStatus.findUnique({
              where: { id: therapistHandle },
            });

            if (!status || !status.hasConfirmedBooking) {
              return;
            }

            const otherConfirmed = await tx.appointmentRequest.findFirst({
              where: {
                therapistHandle,
                status: { in: [...CONFIRMED_ACTIVE_STATUSES] },
              },
              select: { id: true },
            });

            if (otherConfirmed) {
              return;
            }

            await tx.therapistBookingStatus.update({
              where: { id: therapistHandle },
              data: {
                hasConfirmedBooking: false,
                confirmedAt: null,
              },
            });

            logger.info(
              { therapistHandle },
              'Unmarked therapist as having confirmed booking'
            );
          },
          {
            isolationLevel: 'Serializable',
            maxWait: 5000,
            timeout: 10000,
          }
        );
        return; // Success
      } catch (error) {
        lastError = error;
        if (isSerializationError(error) && attempt < MAX_ATTEMPTS - 1) {
          const delay = getBackoffDelay(attempt);
          logger.warn(
            { therapistHandle, attempt: attempt + 1, delayMs: delay },
            'Serialization conflict in unmarkConfirmed - retrying with backoff'
          );
          await sleep(delay);
          continue;
        }
        break;
      }
    }

    logger.error(
      { error: lastError, therapistHandle, operation: 'unmarkConfirmed' },
      'Failed to unmark therapist confirmed status'
    );
  }
}

export const therapistBookingStatusService = new TherapistBookingStatusService();
