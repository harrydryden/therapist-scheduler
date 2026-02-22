import { prisma } from '../utils/database';
import { Prisma } from '@prisma/client';
import { logger } from '../utils/logger';
import { THERAPIST_BOOKING } from '../constants';
import { notionService } from './notion.service';

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
 * Sleep for specified milliseconds
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
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

/**
 * Calculate hours elapsed between two timestamps using UTC milliseconds.
 *
 * IMPORTANT: JavaScript Date.getTime() returns UTC milliseconds, which are NOT
 * affected by DST transitions. This means a 36-hour freeze is always exactly
 * 36 hours of elapsed time, regardless of timezone changes.
 *
 * The previous implementation incorrectly applied a 1-hour tolerance that
 * effectively made a 36-hour freeze only 35 hours. This has been removed
 * since UTC calculations are inherently DST-safe.
 *
 * @param fromTimestamp - Earlier timestamp (e.g., activity time)
 * @param toTimestamp - Later timestamp (e.g., now) - defaults to Date.now()
 * @returns Hours elapsed (precise UTC-based calculation)
 */
function getHoursSince(
  fromTimestamp: Date,
  toTimestamp: Date = new Date()
): number {
  // getTime() returns UTC milliseconds - not affected by DST
  // 36 hours in milliseconds is always 36 * 60 * 60 * 1000, regardless of timezone
  return (toTimestamp.getTime() - fromTimestamp.getTime()) / (1000 * 60 * 60);
}

/**
 * Check if enough hours have passed.
 *
 * Uses exact UTC-based comparison. No DST tolerance needed because
 * Date.getTime() returns UTC milliseconds which are not affected by
 * daylight saving transitions.
 *
 * @param hoursSince - Actual hours elapsed (from getHoursSince)
 * @param thresholdHours - The threshold to compare against
 * @returns true if hours >= threshold
 */
function hasThresholdPassed(
  hoursSince: number,
  thresholdHours: number
): boolean {
  // Direct comparison - no tolerance needed for UTC calculations
  // A 36-hour threshold means exactly 36 hours of elapsed time
  return hoursSince >= thresholdHours;
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
    therapistNotionId: string,
    userEmail: string,
    tx?: TransactionClient
  ): Promise<TherapistAvailabilityStatus> {
    const client: PrismaClient | TransactionClient = tx || prisma;

    try {
      const status = await client.therapistBookingStatus.findUnique({
        where: { id: therapistNotionId },
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
          therapistNotionId,
          userEmail,
          status: { notIn: ['cancelled'] },
        },
        select: { id: true },
      });

      if (existingRequest) {
        // User already has an active request, allow them to continue
        return { canAcceptNewRequests: true, reason: 'available' };
      }

      // Already at max unique requests (2) - fully frozen
      if (status.uniqueRequestCount >= THERAPIST_BOOKING.MAX_UNIQUE_REQUESTS) {
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
            therapistNotionId,
            status: { notIn: ['cancelled'] },
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
          therapistNotionId,
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
   * @param tx - Optional transaction client for atomic operations
   */
  async recordNewRequest(
    therapistNotionId: string,
    therapistName: string,
    userEmail: string,
    tx?: TransactionClient
  ): Promise<void> {
    // If already in a transaction, use it directly
    if (tx) {
      await this.recordNewRequestInner(tx, therapistNotionId, therapistName, userEmail);
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
            await this.recordNewRequestInner(txClient, therapistNotionId, therapistName, userEmail);
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
            { therapistNotionId, userEmail, attempt: attempt + 1, delayMs: delay },
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
      { error: lastError, therapistNotionId, userEmail, operation: 'recordNewRequest', retries: SERIALIZATION_RETRY.MAX_RETRIES },
      'Failed to record new request after retries - propagating error'
    );
    throw lastError;
  }

  /**
   * Inner implementation of recordNewRequest - must be called within a transaction
   */
  private async recordNewRequestInner(
    client: TransactionClient,
    therapistNotionId: string,
    therapistName: string,
    userEmail: string
  ): Promise<void> {
    // Count unique email addresses that have requested this therapist
    const uniqueEmails = await client.appointmentRequest.groupBy({
      by: ['userEmail'],
      where: {
        therapistNotionId,
        status: { notIn: ['cancelled'] },
      },
    });

    // Include the new request email
    const emailSet = new Set(uniqueEmails.map((e) => e.userEmail));
    emailSet.add(userEmail);
    const uniqueCount = emailSet.size;

    const now = new Date();

    await client.therapistBookingStatus.upsert({
      where: { id: therapistNotionId },
      create: {
        id: therapistNotionId,
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
      { therapistNotionId, therapistName, uniqueCount, userEmail },
      'Therapist frozen due to new request'
    );
  }

  /**
   * Mark a therapist as having a confirmed booking
   */
  async markConfirmed(therapistNotionId: string, therapistName: string): Promise<void> {
    try {
      await prisma.therapistBookingStatus.upsert({
        where: { id: therapistNotionId },
        create: {
          id: therapistNotionId,
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
        { therapistNotionId, therapistName },
        'Therapist marked as having confirmed booking'
      );
    } catch (error) {
      logger.error({ error, therapistNotionId }, 'Failed to mark therapist as confirmed');
      // Propagate error so caller knows the freeze failed
      throw error;
    }
  }

  /**
   * Get all therapists that should be hidden from the frontend
   *
   * Uses the "Frozen" checkbox in Notion as the source of truth.
   * The backend syncs freeze status to Notion, but admin can override by unchecking.
   *
   * Visibility logic (Active takes precedence over Frozen):
   * - Active + Not Frozen = VISIBLE
   * - Active + Frozen = HIDDEN (frozen)
   * - Inactive + Not Frozen = HIDDEN (inactive)
   * - Inactive + Frozen = HIDDEN (inactive)
   *
   * This method returns therapist IDs that are frozen (for active therapists).
   * Inactive therapists are already filtered out by the fetchTherapists query.
   */
  async getUnavailableTherapistIds(): Promise<string[]> {
    try {
      // Get frozen therapist IDs directly from Notion
      // This respects any admin overrides (if admin unchecks Frozen, therapist becomes available)
      const frozenIds = await notionService.getFrozenTherapistIds();

      logger.debug(
        { frozenCount: frozenIds.length },
        'Retrieved frozen therapist IDs from Notion'
      );

      return frozenIds;
    } catch (error) {
      logger.error({ error, operation: 'getUnavailableTherapistIds' }, 'Failed to get unavailable therapist IDs');
      return [];
    }
  }

  /**
   * Determine if a therapist should be frozen based on booking status
   * Called by the sync service to update Notion
   *
   * Simplified logic:
   * - Confirmed booking = frozen
   * - Active conversations with frozenAt set = frozen
   * - frozenAt cleared by auto-unfreeze = not frozen
   */
  async shouldTherapistBeFrozen(therapistNotionId: string): Promise<boolean> {
    try {
      const status = await prisma.therapistBookingStatus.findUnique({
        where: { id: therapistNotionId },
      });

      if (!status) {
        return false; // No booking activity = not frozen
      }

      // Confirmed booking = always frozen
      if (status.hasConfirmedBooking) {
        return true;
      }

      // Check if frozen flag is set (set on new request, cleared by auto-unfreeze)
      if (status.frozenAt) {
        // Verify there are still active conversations
        const activeRequest = await prisma.appointmentRequest.findFirst({
          where: {
            therapistNotionId,
            status: { in: ['pending', 'contacted', 'negotiating'] },
          },
          select: { id: true },
        });

        if (activeRequest) {
          return true; // Frozen with active conversation
        }
      }

      return false;
    } catch (error) {
      logger.error({ error, therapistNotionId }, 'Failed to check if therapist should be frozen');
      return false;
    }
  }

  /**
   * Batch compute freeze status for multiple therapists
   * Optimized: Uses 2 queries total instead of N+1
   *
   * @param therapistIds - Array of therapist Notion IDs to check
   * @returns Map of therapistNotionId → shouldBeFrozen
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

      // Find therapist IDs that have frozenAt but not hasConfirmedBooking
      // These need the active appointment check
      const needsActiveCheck = statuses
        .filter(s => s.frozenAt && !s.hasConfirmedBooking)
        .map(s => s.id);

      // Query 2: Get therapists with active conversations (single query)
      const therapistsWithActiveConversations = new Set<string>();
      if (needsActiveCheck.length > 0) {
        const activeAppointments = await prisma.appointmentRequest.findMany({
          where: {
            therapistNotionId: { in: needsActiveCheck },
            status: { in: ['pending', 'contacted', 'negotiating'] },
          },
          select: { therapistNotionId: true },
          distinct: ['therapistNotionId'],
        });
        activeAppointments.forEach(a => therapistsWithActiveConversations.add(a.therapistNotionId));
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

        if (status.frozenAt && therapistsWithActiveConversations.has(therapistId)) {
          result.set(therapistId, true); // Frozen with active conversation
          continue;
        }

        result.set(therapistId, false);
      }

      return result;
    } catch (error) {
      logger.error({ error, count: therapistIds.length }, 'Failed to batch compute freeze status');
      // Fall back to individual queries on error
      for (const id of therapistIds) {
        result.set(id, await this.shouldTherapistBeFrozen(id));
      }
      return result;
    }
  }

  /**
   * Check for therapists with 2 threads both inactive for the threshold period
   * Flags them for admin attention
   *
   * @deprecated Use checkAndHandleInactiveTherapists instead which combines flagging and auto-unfreeze
   *
   * OPTIMIZED: Uses atomic UPDATE with subquery to prevent race conditions
   *
   * Returns:
   * - >= 0: Number of therapists flagged
   * - -1: Query failed (error logged)
   */
  async checkAndFlagStaleTherapists(): Promise<number> {
    // Use the unified inactivity threshold
    const staleThresholdMs = THERAPIST_BOOKING.INACTIVITY_ALERT_HOURS * 60 * 60 * 1000;
    const staleThreshold72h = new Date(Date.now() - staleThresholdMs);
    const now = new Date();

    try {
      // Atomic update: Flag therapists where ALL active appointments are stale (72h)
      // Uses NOT EXISTS to ensure no recent activity on any thread
      //
      // FIX B4: Removed overly strict NULL check that caused false negatives
      // Previous logic blocked flagging if ANY appointment had null activity,
      // which prevented flagging therapists with 2 stale threads where one was legacy data.
      //
      // New logic: Flag if NO active appointments have recent activity (>= 72h threshold)
      // Appointments with null activity are treated as stale (conservative approach)
      // This ensures admin gets alerted even for legacy data without activity tracking
      const flaggedResult = await prisma.$executeRaw`
        UPDATE therapist_booking_status tbs
        SET admin_alert_at = ${now}, updated_at = ${now}
        WHERE tbs.has_confirmed_booking = false
          AND tbs.unique_request_count >= ${THERAPIST_BOOKING.MAX_UNIQUE_REQUESTS}
          AND tbs.admin_alert_at IS NULL
          AND EXISTS (
            SELECT 1 FROM appointment_requests ar
            WHERE ar.therapist_notion_id = tbs.id
              AND ar.status IN ('pending', 'contacted', 'negotiating')
          )
          AND NOT EXISTS (
            SELECT 1 FROM appointment_requests ar
            WHERE ar.therapist_notion_id = tbs.id
              AND ar.status IN ('pending', 'contacted', 'negotiating')
              AND ar.last_activity_at IS NOT NULL
              AND ar.last_activity_at >= ${staleThreshold72h}
          )
      `;

      const count = Number(flaggedResult);

      // Explicitly distinguish between "no stale therapists" and success with results
      if (count > 0) {
        logger.warn(
          { flaggedCount: count, threshold: '72h' },
          'Flagged therapists for admin attention due to stale threads'
        );
      } else {
        logger.debug(
          { threshold: '72h' },
          'Stale therapist check completed - no therapists need flagging'
        );
      }

      return count;
    } catch (error) {
      // CRITICAL: Distinguish between "query failed" and "no results"
      // Return -1 to indicate error, caller can decide how to handle
      logger.error(
        { error, operation: 'checkAndFlagStaleTherapists', threshold: staleThreshold72h },
        'FAILED to check stale therapists - admin alerts may be missed'
      );
      return -1;
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

    try {
      // 1. Flag therapists with 2+ threads where ALL are inactive
      // These need admin attention (might want to cancel stale conversations)
      const flaggedResult = await prisma.$executeRaw`
        UPDATE therapist_booking_status tbs
        SET admin_alert_at = ${now}, updated_at = ${now}
        WHERE tbs.has_confirmed_booking = false
          AND tbs.unique_request_count >= ${THERAPIST_BOOKING.MAX_UNIQUE_REQUESTS}
          AND tbs.admin_alert_at IS NULL
          AND EXISTS (
            SELECT 1 FROM appointment_requests ar
            WHERE ar.therapist_notion_id = tbs.id
              AND ar.status IN ('pending', 'contacted', 'negotiating')
          )
          AND NOT EXISTS (
            SELECT 1 FROM appointment_requests ar
            WHERE ar.therapist_notion_id = tbs.id
              AND ar.status IN ('pending', 'contacted', 'negotiating')
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
            therapistNotionId: { in: therapistIds },
            status: { in: ['pending', 'contacted', 'negotiating'] },
          },
          select: { therapistNotionId: true, lastActivityAt: true },
        });

        // Group conversations by therapist
        const conversationsByTherapist = new Map<string, Array<{ lastActivityAt: Date | null }>>();
        for (const conv of allActiveConversations) {
          const existing = conversationsByTherapist.get(conv.therapistNotionId) || [];
          existing.push({ lastActivityAt: conv.lastActivityAt });
          conversationsByTherapist.set(conv.therapistNotionId, existing);
        }

        // Collect IDs to unfreeze in bulk
        const idsToUnfreeze: string[] = [];

        for (const therapist of therapistsToUnfreeze) {
          const conversations = conversationsByTherapist.get(therapist.id);

          // If no active conversations, skip (already handled by other flows)
          if (!conversations || conversations.length === 0) continue;

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
      return { flaggedCount: -1, unfrozenCount: 0 };
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
  async acknowledgeFlaggedTherapist(therapistNotionId: string): Promise<void> {
    try {
      await prisma.therapistBookingStatus.update({
        where: { id: therapistNotionId },
        data: { adminAlertAcknowledged: true },
      });

      logger.info({ therapistNotionId }, 'Admin acknowledged flagged therapist');
    } catch (error) {
      logger.error({ error, therapistNotionId }, 'Failed to acknowledge flagged therapist');
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
            WHEN tbs.frozen_at IS NOT NULL AND EXISTS (
              SELECT 1 FROM appointment_requests ar
              WHERE ar.therapist_notion_id = tbs.id
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
  async recalculateUniqueRequestCount(therapistNotionId: string): Promise<void> {
    const MAX_ATTEMPTS = 2;
    let lastError: unknown = null;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      try {
        await prisma.$transaction(
          async (tx) => {
            // Count unique email addresses with active requests
            const uniqueEmails = await tx.appointmentRequest.groupBy({
              by: ['userEmail'],
              where: {
                therapistNotionId,
                status: { notIn: ['cancelled'] },
              },
            });

            const uniqueCount = uniqueEmails.length;

            // Check if status record exists
            const status = await tx.therapistBookingStatus.findUnique({
              where: { id: therapistNotionId },
            });

            if (!status) {
              // No status record means therapist was never booked - nothing to update
              return;
            }

            // If count is 0, we can delete the status record (therapist fully available)
            if (uniqueCount === 0) {
              await tx.therapistBookingStatus.delete({
                where: { id: therapistNotionId },
              });
              logger.info(
                { therapistNotionId },
                'Removed therapist booking status - no active requests remaining'
              );
              return;
            }

            // Update the count
            await tx.therapistBookingStatus.update({
              where: { id: therapistNotionId },
              data: {
                uniqueRequestCount: uniqueCount,
                // Reset admin alert if count drops below threshold
                ...(uniqueCount < THERAPIST_BOOKING.MAX_UNIQUE_REQUESTS && {
                  adminAlertAt: null,
                  adminAlertAcknowledged: false,
                }),
              },
            });

            logger.info(
              { therapistNotionId, uniqueCount },
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
            { therapistNotionId, attempt: attempt + 1, delayMs: delay },
            'Serialization conflict in recalculateUniqueRequestCount - retrying with backoff'
          );
          await sleep(delay);
          continue;
        }
        break;
      }
    }

    logger.error(
      { error: lastError, therapistNotionId, operation: 'recalculateUniqueRequestCount' },
      'Failed to recalculate unique request count'
    );
  }

  /**
   * Unmark a therapist as having a confirmed booking
   * Should be called when a confirmed appointment is cancelled
   * Uses Serializable transaction to prevent race conditions where another
   * appointment is confirmed between our check and update
   */
  async unmarkConfirmed(therapistNotionId: string): Promise<void> {
    const MAX_ATTEMPTS = 2;
    let lastError: unknown = null;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      try {
        await prisma.$transaction(
          async (tx) => {
            const status = await tx.therapistBookingStatus.findUnique({
              where: { id: therapistNotionId },
            });

            if (!status || !status.hasConfirmedBooking) {
              return;
            }

            const otherConfirmed = await tx.appointmentRequest.findFirst({
              where: {
                therapistNotionId,
                status: 'confirmed',
              },
              select: { id: true },
            });

            if (otherConfirmed) {
              return;
            }

            await tx.therapistBookingStatus.update({
              where: { id: therapistNotionId },
              data: {
                hasConfirmedBooking: false,
                confirmedAt: null,
              },
            });

            logger.info(
              { therapistNotionId },
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
            { therapistNotionId, attempt: attempt + 1, delayMs: delay },
            'Serialization conflict in unmarkConfirmed - retrying with backoff'
          );
          await sleep(delay);
          continue;
        }
        break;
      }
    }

    logger.error(
      { error: lastError, therapistNotionId, operation: 'unmarkConfirmed' },
      'Failed to unmark therapist confirmed status'
    );
  }
}

export const therapistBookingStatusService = new TherapistBookingStatusService();
