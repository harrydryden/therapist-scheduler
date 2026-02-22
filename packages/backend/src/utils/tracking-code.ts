/**
 * Tracking Code Utility
 *
 * Generates and parses unique tracking codes for appointment email matching.
 * Format: SPL-{userOdIdLast4}-{therapistOdIdLast4}-{seq} (e.g., SPL-7890-3210-1)
 *
 * The tracking code is based on:
 * - Last 4 digits of the user's unique ID (odId)
 * - Last 4 digits of the therapist's unique ID (odId)
 * - A sequence number for multiple appointments between same user/therapist
 *
 * IMPORTANT: Each appointment gets a UNIQUE tracking code.
 * This ensures that feedback forms, email matching, and other features
 * can correctly identify the specific appointment.
 *
 * Purpose: Provides deterministic email matching even before Gmail thread IDs
 * are established, preventing cross-contamination when users have multiple
 * active appointments.
 */

import crypto from 'crypto';
import { Prisma } from '@prisma/client';
import { prisma } from './database';
import { logger } from './logger';

type TransactionClient = Prisma.TransactionClient;

// Tracking code format: SPL-{userLast4}-{therapistLast4}-{seq}
const TRACKING_CODE_PREFIX = 'SPL';

/**
 * Get the last 4 digits of an odId, or generate a random 4-digit string as fallback
 */
function getLast4Digits(odId: string | null | undefined): string {
  if (odId && odId.length >= 4) {
    return odId.slice(-4);
  }
  // Fallback: generate cryptographically random 4 digits to avoid collisions
  const randomValue = crypto.randomInt(1000, 10000);
  return randomValue.toString();
}

/**
 * Generate a new unique tracking code for an appointment
 *
 * Each appointment gets its own unique tracking code based on user and therapist IDs.
 * Format: SPL-{userLast4}-{therapistLast4}-{seq}
 */
export async function getOrCreateTrackingCode(
  userEmail: string,
  therapistEmail: string,
  tx?: TransactionClient
): Promise<string> {
  const db = tx || prisma;
  const normalizedUserEmail = userEmail.toLowerCase().trim();
  const normalizedTherapistEmail = therapistEmail.toLowerCase().trim();

  // Look up user and therapist to get their odIds
  const [user, therapist] = await Promise.all([
    db.user.findFirst({
      where: { email: normalizedUserEmail },
      select: { odId: true },
    }),
    db.therapist.findFirst({
      where: { email: normalizedTherapistEmail },
      select: { odId: true },
    }),
  ]);

  const userLast4 = getLast4Digits(user?.odId);
  const therapistLast4 = getLast4Digits(therapist?.odId);

  // Find existing appointments with this user/therapist combination to determine sequence
  const existingAppointments = await db.appointmentRequest.findMany({
    where: {
      trackingCode: {
        startsWith: `${TRACKING_CODE_PREFIX}-${userLast4}-${therapistLast4}-`,
      },
    },
    select: { trackingCode: true },
    orderBy: { trackingCode: 'desc' },
  });

  // Determine the next sequence number
  let nextSeq = 1;
  if (existingAppointments.length > 0) {
    // Extract the highest sequence number
    for (const apt of existingAppointments) {
      const match = apt.trackingCode?.match(/-(\d+)$/);
      if (match) {
        const seq = parseInt(match[1], 10);
        if (seq >= nextSeq) {
          nextSeq = seq + 1;
        }
      }
    }
  }

  const newCode = `${TRACKING_CODE_PREFIX}-${userLast4}-${therapistLast4}-${nextSeq}`;

  logger.info(
    {
      userEmail: normalizedUserEmail,
      therapistEmail: normalizedTherapistEmail,
      trackingCode: newCode,
      userOdId: user?.odId,
      therapistOdId: therapist?.odId,
    },
    'Generated new unique tracking code for appointment'
  );

  return newCode;
}

/**
 * Extract tracking code from email subject
 * Supports both formats:
 * - New format: SPL-1234-5678-1 (user/therapist ID based)
 * - Legacy format: SPL123 (sequential)
 * Returns null if no valid tracking code found
 */
export function extractTrackingCode(subject: string): string | null {
  // Try new format first: SPL-1234-5678-1
  const newFormatMatch = subject.match(/SPL-(\d{4})-(\d{4})-(\d+)/i);
  if (newFormatMatch) {
    return `${TRACKING_CODE_PREFIX}-${newFormatMatch[1]}-${newFormatMatch[2]}-${newFormatMatch[3]}`;
  }

  // Fall back to legacy format: SPL123
  const legacyMatch = subject.match(/SPL(\d+)/i);
  if (legacyMatch) {
    return `${TRACKING_CODE_PREFIX}${legacyMatch[1]}`;
  }

  return null;
}

/**
 * Format tracking code for display in email subject
 * Adds brackets for visibility: [SPL1]
 */
export function formatTrackingCodeForSubject(code: string): string {
  return `[${code}]`;
}

/**
 * Prepend tracking code to email subject if not already present
 * Places code at START for better visibility and consistency
 */
export function prependTrackingCodeToSubject(subject: string, code: string): string {
  // Check if code already in subject (case insensitive)
  if (subject.toUpperCase().includes(code.toUpperCase())) {
    return subject;
  }
  return `${formatTrackingCodeForSubject(code)} ${subject}`;
}

/**
 * Find appointment by tracking code
 * Used as fallback when thread ID matching fails
 *
 * Each appointment has a unique tracking code, so this returns at most one appointment.
 */
export async function findAppointmentByTrackingCode(
  trackingCode: string,
  matchableStatuses: string[]
): Promise<{ id: string; userEmail: string; therapistEmail: string } | null> {
  const appointment = await prisma.appointmentRequest.findFirst({
    where: {
      trackingCode: trackingCode,
      status: { in: matchableStatuses as any },
    },
    select: { id: true, userEmail: true, therapistEmail: true },
  });

  if (appointment) {
    logger.info(
      { trackingCode, appointmentId: appointment.id },
      'Matched appointment by tracking code'
    );
  }

  return appointment;
}

/**
 * Find all appointments for a tracking code
 * Should typically return 0-1 appointments since codes are unique,
 * but kept for backwards compatibility with any legacy shared codes.
 */
export async function findAllAppointmentsByTrackingCode(
  trackingCode: string,
  matchableStatuses: string[]
): Promise<Array<{ id: string; userEmail: string; therapistEmail: string; updatedAt: Date }>> {
  const appointments = await prisma.appointmentRequest.findMany({
    where: {
      trackingCode: trackingCode,
      status: { in: matchableStatuses as any },
    },
    select: { id: true, userEmail: true, therapistEmail: true, updatedAt: true },
    orderBy: { updatedAt: 'desc' },
  });

  return appointments;
}

/**
 * Backfill tracking codes for appointments that don't have one
 * Returns the number of appointments updated
 */
export async function backfillMissingTrackingCodes(): Promise<{
  updated: number;
  errors: string[];
}> {
  const appointmentsWithoutCodes = await prisma.appointmentRequest.findMany({
    where: {
      trackingCode: null,
    },
    select: {
      id: true,
      userEmail: true,
      therapistEmail: true,
    },
    orderBy: { createdAt: 'asc' }, // Process oldest first for consistent numbering
  });

  logger.info(
    { count: appointmentsWithoutCodes.length },
    'Found appointments without tracking codes'
  );

  let updated = 0;
  const errors: string[] = [];

  // FIX #22: Process each backfill inside a Serializable transaction to prevent
  // duplicate sequence numbers from concurrent getOrCreateTrackingCode calls
  for (const appointment of appointmentsWithoutCodes) {
    try {
      await prisma.$transaction(async (tx) => {
        const newCode = await getOrCreateTrackingCode(
          appointment.userEmail,
          appointment.therapistEmail,
          tx
        );

        await tx.appointmentRequest.update({
          where: { id: appointment.id },
          data: { trackingCode: newCode },
        });

        updated++;
        logger.info(
          { appointmentId: appointment.id, trackingCode: newCode },
          'Backfilled tracking code'
        );
      }, { isolationLevel: 'Serializable' });
    } catch (error) {
      const errorMsg = `Failed to backfill ${appointment.id}: ${error instanceof Error ? error.message : 'Unknown error'}`;
      errors.push(errorMsg);
      logger.error({ appointmentId: appointment.id, error }, 'Failed to backfill tracking code');
    }
  }

  return { updated, errors };
}

/**
 * Fix duplicate tracking codes by assigning new unique codes
 * Returns the number of appointments updated
 */
export async function fixDuplicateTrackingCodes(): Promise<{
  duplicatesFound: number;
  fixed: number;
  errors: string[];
}> {
  // Find all tracking codes that are used more than once
  const duplicates = await prisma.$queryRaw<Array<{ tracking_code: string; count: bigint }>>`
    SELECT tracking_code, COUNT(*) as count
    FROM appointment_requests
    WHERE tracking_code IS NOT NULL
    GROUP BY tracking_code
    HAVING COUNT(*) > 1
    ORDER BY tracking_code
  `;

  const duplicatesFound = duplicates.length;
  let fixed = 0;
  const errors: string[] = [];

  logger.info(
    { duplicatesFound },
    'Found duplicate tracking codes to fix'
  );

  for (const dup of duplicates) {
    // Get all appointments with this code, ordered by creation date
    const appointments = await prisma.appointmentRequest.findMany({
      where: { trackingCode: dup.tracking_code },
      select: { id: true, userEmail: true, therapistEmail: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    });

    // Keep the first (oldest) appointment with the original code
    // Assign new unique codes to all others
    // FIX #22: Wrap each reassignment in a Serializable transaction
    for (let i = 1; i < appointments.length; i++) {
      const appointment = appointments[i];
      try {
        await prisma.$transaction(async (tx) => {
          const newCode = await getOrCreateTrackingCode(
            appointment.userEmail,
            appointment.therapistEmail,
            tx
          );

          await tx.appointmentRequest.update({
            where: { id: appointment.id },
            data: { trackingCode: newCode },
          });

          fixed++;
          logger.info(
            { appointmentId: appointment.id, oldCode: dup.tracking_code, newCode },
            'Fixed duplicate tracking code'
          );
        }, { isolationLevel: 'Serializable' });
      } catch (error) {
        const errorMsg = `Failed to fix duplicate for ${appointment.id}: ${error instanceof Error ? error.message : 'Unknown error'}`;
        errors.push(errorMsg);
        logger.error({ appointmentId: appointment.id, error }, 'Failed to fix duplicate tracking code');
      }
    }
  }

  return { duplicatesFound, fixed, errors };
}

/**
 * Migrate legacy tracking codes (SPL123) to new format (SPL-1234-5678-1)
 * Returns the number of appointments migrated
 */
export async function migrateLegacyTrackingCodes(): Promise<{
  migrated: number;
  errors: string[];
}> {
  // Find all appointments with legacy format codes (SPL followed by just digits, no dashes)
  const legacyAppointments = await prisma.appointmentRequest.findMany({
    where: {
      trackingCode: {
        not: null,
      },
      NOT: {
        trackingCode: {
          contains: '-',
        },
      },
    },
    select: {
      id: true,
      trackingCode: true,
      userEmail: true,
      therapistEmail: true,
    },
    orderBy: { createdAt: 'asc' },
  });

  logger.info(
    { count: legacyAppointments.length },
    'Found appointments with legacy tracking codes to migrate'
  );

  let migrated = 0;
  const errors: string[] = [];

  // FIX #22: Wrap each migration in a Serializable transaction
  for (const appointment of legacyAppointments) {
    try {
      await prisma.$transaction(async (tx) => {
        const newCode = await getOrCreateTrackingCode(
          appointment.userEmail,
          appointment.therapistEmail,
          tx
        );

        await tx.appointmentRequest.update({
          where: { id: appointment.id },
          data: { trackingCode: newCode },
        });

        migrated++;
        logger.info(
          { appointmentId: appointment.id, oldCode: appointment.trackingCode, newCode },
          'Migrated legacy tracking code'
        );
      }, { isolationLevel: 'Serializable' });
    } catch (error) {
      const errorMsg = `Failed to migrate ${appointment.id}: ${error instanceof Error ? error.message : 'Unknown error'}`;
      errors.push(errorMsg);
      logger.error({ appointmentId: appointment.id, error }, 'Failed to migrate legacy tracking code');
    }
  }

  return { migrated, errors };
}
