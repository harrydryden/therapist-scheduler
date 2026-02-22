/**
 * Unique ID Generator
 *
 * Generates unique 10-digit numeric IDs for users and therapists.
 * Format: 10 digits (e.g., 1234567890)
 *
 * These IDs are:
 * - Human-readable and easy to communicate
 * - Unique across the system
 * - Not sequential (to prevent enumeration)
 */

import { prisma } from './database';
import { logger } from './logger';

// ID range: 1000000000 to 9999999999 (10 digits)
const MIN_ID = 1000000000;
const MAX_ID = 9999999999;

/**
 * Generate a random 10-digit ID
 */
function generateRandomId(): string {
  const id = Math.floor(Math.random() * (MAX_ID - MIN_ID + 1)) + MIN_ID;
  return id.toString();
}

/**
 * Generate a unique 10-digit user ID
 * Checks for collisions and retries if needed
 */
export async function generateUniqueUserId(): Promise<string> {
  const maxAttempts = 10;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const candidateId = generateRandomId();

    // Check if this ID already exists
    const existing = await prisma.user.findUnique({
      where: { odId: candidateId },
      select: { odId: true },
    });

    if (!existing) {
      logger.debug({ odId: candidateId }, 'Generated unique user ID');
      return candidateId;
    }

    logger.debug({ odId: candidateId, attempt }, 'User ID collision, retrying');
  }

  // Fallback: use timestamp-based ID if random keeps colliding
  const fallbackId = (Date.now() % (MAX_ID - MIN_ID + 1) + MIN_ID).toString();
  logger.warn({ odId: fallbackId }, 'Used fallback timestamp-based user ID');
  return fallbackId;
}

/**
 * Generate a unique 10-digit therapist ID
 * Checks for collisions and retries if needed
 */
export async function generateUniqueTherapistId(): Promise<string> {
  const maxAttempts = 10;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const candidateId = generateRandomId();

    // Check if this ID already exists
    const existing = await prisma.therapist.findUnique({
      where: { odId: candidateId },
      select: { odId: true },
    });

    if (!existing) {
      logger.debug({ odId: candidateId }, 'Generated unique therapist ID');
      return candidateId;
    }

    logger.debug({ odId: candidateId, attempt }, 'Therapist ID collision, retrying');
  }

  // Fallback: use timestamp-based ID if random keeps colliding
  const fallbackId = (Date.now() % (MAX_ID - MIN_ID + 1) + MIN_ID).toString();
  logger.warn({ odId: fallbackId }, 'Used fallback timestamp-based therapist ID');
  return fallbackId;
}

/**
 * Get or create a User record by email
 * Returns the user with their unique odId
 */
export async function getOrCreateUser(
  email: string,
  name?: string | null
): Promise<{ id: string; odId: string; email: string; name: string | null; createdAt: Date; updatedAt: Date }> {
  const normalizedEmail = email.toLowerCase().trim();

  // Check if user already exists
  const existing = await prisma.user.findUnique({
    where: { email: normalizedEmail },
  });

  if (existing) {
    // Update name if provided and different
    if (name && name !== existing.name) {
      const updated = await prisma.user.update({
        where: { email: normalizedEmail },
        data: { name },
      });
      return updated;
    }
    return existing;
  }

  // Create new user with unique ID
  const odId = await generateUniqueUserId();
  const newUser = await prisma.user.create({
    data: {
      email: normalizedEmail,
      name: name || null,
      odId,
    },
  });

  logger.info(
    { userId: newUser.id, odId: newUser.odId, email: normalizedEmail },
    'Created new user with unique ID'
  );

  return newUser;
}

/**
 * Get or create a Therapist record by Notion ID
 * Returns the therapist with their unique odId
 */
export async function getOrCreateTherapist(
  notionId: string,
  email: string,
  name: string
): Promise<{ id: string; odId: string; notionId: string; email: string; name: string; createdAt: Date; updatedAt: Date }> {
  const normalizedEmail = email.toLowerCase().trim();

  // Check if therapist already exists by Notion ID
  const existing = await prisma.therapist.findUnique({
    where: { notionId },
  });

  if (existing) {
    // Update email/name if different
    if (normalizedEmail !== existing.email || name !== existing.name) {
      const updated = await prisma.therapist.update({
        where: { notionId },
        data: { email: normalizedEmail, name },
      });
      return updated;
    }
    return existing;
  }

  // Create new therapist with unique ID
  const odId = await generateUniqueTherapistId();
  const newTherapist = await prisma.therapist.create({
    data: {
      notionId,
      email: normalizedEmail,
      name,
      odId,
    },
  });

  logger.info(
    { therapistId: newTherapist.id, odId: newTherapist.odId, notionId, email: normalizedEmail },
    'Created new therapist with unique ID'
  );

  return newTherapist;
}

/**
 * Backfill users from existing appointments
 * Creates User records for all unique userEmails in appointments
 */
export async function backfillUsers(): Promise<{
  created: number;
  skipped: number;
  errors: string[];
}> {
  // Get all unique user emails from appointments
  const uniqueUsers = await prisma.appointmentRequest.findMany({
    select: {
      userEmail: true,
      userName: true,
    },
    distinct: ['userEmail'],
  });

  logger.info({ count: uniqueUsers.length }, 'Found unique users to backfill');

  let created = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (const { userEmail, userName } of uniqueUsers) {
    try {
      const existing = await prisma.user.findUnique({
        where: { email: userEmail.toLowerCase().trim() },
      });

      if (existing) {
        skipped++;
        continue;
      }

      await getOrCreateUser(userEmail, userName);
      created++;
    } catch (error) {
      const errorMsg = `Failed to create user for ${userEmail}: ${error instanceof Error ? error.message : 'Unknown error'}`;
      errors.push(errorMsg);
      logger.error({ email: userEmail, error }, 'Failed to backfill user');
    }
  }

  logger.info({ created, skipped, errors: errors.length }, 'User backfill complete');
  return { created, skipped, errors };
}

/**
 * Backfill therapists from existing appointments
 * Creates Therapist records for all unique therapists in appointments
 */
export async function backfillTherapists(): Promise<{
  created: number;
  skipped: number;
  errors: string[];
}> {
  // Get all unique therapists from appointments
  const uniqueTherapists = await prisma.appointmentRequest.findMany({
    select: {
      therapistNotionId: true,
      therapistEmail: true,
      therapistName: true,
    },
    distinct: ['therapistNotionId'],
  });

  logger.info({ count: uniqueTherapists.length }, 'Found unique therapists to backfill');

  let created = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (const { therapistNotionId, therapistEmail, therapistName } of uniqueTherapists) {
    try {
      const existing = await prisma.therapist.findUnique({
        where: { notionId: therapistNotionId },
      });

      if (existing) {
        skipped++;
        continue;
      }

      await getOrCreateTherapist(therapistNotionId, therapistEmail, therapistName);
      created++;
    } catch (error) {
      const errorMsg = `Failed to create therapist for ${therapistNotionId}: ${error instanceof Error ? error.message : 'Unknown error'}`;
      errors.push(errorMsg);
      logger.error({ notionId: therapistNotionId, error }, 'Failed to backfill therapist');
    }
  }

  logger.info({ created, skipped, errors: errors.length }, 'Therapist backfill complete');
  return { created, skipped, errors };
}

/**
 * Link existing appointments to User and Therapist records
 * Updates userId and therapistId fields on appointments
 */
export async function linkAppointmentsToEntities(): Promise<{
  linked: number;
  errors: string[];
}> {
  // Get all appointments that don't have userId or therapistId set
  const unlinkedAppointments = await prisma.appointmentRequest.findMany({
    where: {
      OR: [
        { userId: null },
        { therapistId: null },
      ],
    },
    select: {
      id: true,
      userEmail: true,
      therapistNotionId: true,
    },
  });

  logger.info({ count: unlinkedAppointments.length }, 'Found unlinked appointments');

  let linked = 0;
  const errors: string[] = [];

  for (const appointment of unlinkedAppointments) {
    try {
      // Find the user
      const user = await prisma.user.findUnique({
        where: { email: appointment.userEmail.toLowerCase().trim() },
        select: { id: true },
      });

      // Find the therapist
      const therapist = await prisma.therapist.findUnique({
        where: { notionId: appointment.therapistNotionId },
        select: { id: true },
      });

      if (user || therapist) {
        await prisma.appointmentRequest.update({
          where: { id: appointment.id },
          data: {
            userId: user?.id || undefined,
            therapistId: therapist?.id || undefined,
          },
        });
        linked++;
      }
    } catch (error) {
      const errorMsg = `Failed to link appointment ${appointment.id}: ${error instanceof Error ? error.message : 'Unknown error'}`;
      errors.push(errorMsg);
      logger.error({ appointmentId: appointment.id, error }, 'Failed to link appointment');
    }
  }

  logger.info({ linked, errors: errors.length }, 'Appointment linking complete');
  return { linked, errors };
}
