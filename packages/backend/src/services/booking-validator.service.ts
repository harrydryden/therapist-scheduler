/**
 * Booking Validator Service
 *
 * Provides real-time validation for appointment bookings to prevent:
 * - Booking non-existent therapists
 * - Booking frozen/inactive therapists
 * - Race conditions where therapist becomes unavailable between selection and booking
 * - Double-booking the same time slot
 *
 * This service bypasses cache for critical validations to ensure accuracy.
 */

import { prisma } from '../utils/database';
import { notionService } from './notion.service';
import { therapistBookingStatusService } from './therapist-booking-status.service';
import { logger } from '../utils/logger';
import { parseConfirmedDateTime } from '../utils/date-parser';

export interface ValidationResult {
  valid: boolean;
  reason?: string;
  code?: 'NOT_FOUND' | 'FROZEN' | 'INACTIVE' | 'NO_EMAIL' | 'SLOT_TAKEN' | 'RECENT_BOOKING' | 'RATE_LIMITED';
  details?: Record<string, unknown>;
}

export interface ValidateBookingParams {
  therapistNotionId: string;
  userEmail: string;
  /** Optional: check if specific time slot is available */
  confirmedDateTime?: string;
  /** Skip cache and hit Notion directly for freshest data */
  bypassCache?: boolean;
}

class BookingValidatorService {
  /**
   * Validate that a therapist can accept a new booking
   * This is the primary validation called before creating an appointment
   */
  async validateTherapistAvailability(params: ValidateBookingParams): Promise<ValidationResult> {
    const { therapistNotionId, userEmail, confirmedDateTime, bypassCache = false } = params;
    const logContext = { therapistNotionId, userEmail };

    try {
      // 1. Check if therapist exists and is active
      const therapist = await notionService.getTherapist(therapistNotionId, bypassCache);

      if (!therapist) {
        logger.warn(logContext, 'Booking validation failed: therapist not found');
        return {
          valid: false,
          reason: 'Therapist not found',
          code: 'NOT_FOUND',
        };
      }

      // 2. Check if therapist is active
      if (!therapist.active) {
        logger.info(logContext, 'Booking validation failed: therapist inactive');
        return {
          valid: false,
          reason: 'Therapist is not currently accepting new clients',
          code: 'INACTIVE',
        };
      }

      // 3. Check if therapist is frozen
      if (therapist.frozen) {
        logger.info(logContext, 'Booking validation failed: therapist frozen');
        return {
          valid: false,
          reason: 'Therapist has reached maximum pending requests',
          code: 'FROZEN',
        };
      }

      // 4. Check if therapist has email (required for communication)
      if (!therapist.email || therapist.email.trim() === '') {
        logger.warn(logContext, 'Booking validation failed: no therapist email');
        return {
          valid: false,
          reason: 'Therapist is not available for booking at this time',
          code: 'NO_EMAIL',
        };
      }

      // 5. Check booking status service for detailed availability
      // NOTE: This is a preliminary check for fast-reject. The actual booking flow
      // in appointments.routes.ts re-validates inside a Serializable transaction
      // to prevent race conditions between this check and appointment creation.
      const bookingStatus = await therapistBookingStatusService.canAcceptNewRequest(
        therapistNotionId,
        userEmail
      );

      if (!bookingStatus.canAcceptNewRequests) {
        logger.info(
          { ...logContext, reason: bookingStatus.reason },
          'Booking validation failed: booking status check'
        );
        return {
          valid: false,
          reason: bookingStatus.reason === 'confirmed'
            ? 'Therapist is no longer accepting new appointment requests'
            : 'Therapist has reached maximum pending requests',
          code: bookingStatus.reason === 'confirmed' ? 'FROZEN' : 'RATE_LIMITED',
        };
      }

      // 6. If confirmedDateTime provided, check for slot conflicts
      if (confirmedDateTime) {
        const slotConflict = await this.checkSlotConflict(therapistNotionId, confirmedDateTime);
        if (slotConflict) {
          logger.info(
            { ...logContext, confirmedDateTime },
            'Booking validation failed: slot already booked'
          );
          return {
            valid: false,
            reason: 'This time slot has already been booked',
            code: 'SLOT_TAKEN',
            details: { conflictingAppointmentId: slotConflict.id },
          };
        }
      }

      // 7. Check for very recent bookings (race condition window - 5 seconds)
      const recentBooking = await this.checkRecentBookings(therapistNotionId, userEmail);
      if (recentBooking) {
        logger.info(
          { ...logContext, recentBookingId: recentBooking.id },
          'Booking validation: recent booking detected (possible race condition)'
        );
        return {
          valid: false,
          reason: 'A booking request was just submitted. Please wait a moment.',
          code: 'RECENT_BOOKING',
          details: { recentBookingId: recentBooking.id },
        };
      }

      logger.debug(logContext, 'Booking validation passed');
      return { valid: true };

    } catch (error) {
      logger.error(
        { ...logContext, error },
        'Booking validation error'
      );
      // On error, fail open but log it (prefer availability over false rejections)
      // In production, you might want to fail closed instead
      return {
        valid: true, // Fail open
        reason: 'Validation check encountered an error, proceeding with caution',
      };
    }
  }

  /**
   * Check if a specific time slot is already booked.
   * Uses parsed datetime comparison (with 30-minute tolerance) to prevent
   * double-booking when the same time is expressed differently (e.g.
   * "Monday 3rd Feb at 10am" vs "2025-02-03T10:00:00").
   */
  private async checkSlotConflict(
    therapistNotionId: string,
    confirmedDateTime: string
  ): Promise<{ id: string } | null> {
    // First try: check confirmedDateTimeParsed (ISO column) if available
    const requestedDate = parseConfirmedDateTime(confirmedDateTime);
    if (requestedDate) {
      // Allow 30-minute tolerance window to catch same-slot bookings
      const windowStart = new Date(requestedDate.getTime() - 30 * 60 * 1000);
      const windowEnd = new Date(requestedDate.getTime() + 30 * 60 * 1000);
      const conflict = await prisma.appointmentRequest.findFirst({
        where: {
          therapistNotionId,
          confirmedDateTimeParsed: { gte: windowStart, lte: windowEnd },
          status: { notIn: ['cancelled', 'completed'] },
        },
        select: { id: true },
      });
      if (conflict) return conflict;
    }

    // Fallback: exact string match for appointments without parsed dates
    const exactConflict = await prisma.appointmentRequest.findFirst({
      where: {
        therapistNotionId,
        confirmedDateTime,
        status: { notIn: ['cancelled', 'completed'] },
      },
      select: { id: true },
    });

    return exactConflict;
  }

  /**
   * Check for very recent bookings (within 5 seconds) to catch race conditions
   */
  private async checkRecentBookings(
    therapistNotionId: string,
    userEmail: string
  ): Promise<{ id: string } | null> {
    const fiveSecondsAgo = new Date(Date.now() - 5000);

    const recent = await prisma.appointmentRequest.findFirst({
      where: {
        therapistNotionId,
        userEmail,
        createdAt: { gte: fiveSecondsAgo },
        status: { notIn: ['cancelled'] },
      },
      select: { id: true },
    });

    return recent;
  }

  /**
   * Validate a confirmation (when transitioning to confirmed status)
   * Ensures the confirmed datetime doesn't conflict with existing bookings
   */
  async validateConfirmation(
    appointmentId: string,
    therapistNotionId: string,
    confirmedDateTime: string
  ): Promise<ValidationResult> {
    // Check for conflicts using parsed datetime comparison (30-min window)
    const requestedDate = parseConfirmedDateTime(confirmedDateTime);
    let conflict: { id: string; userName: string | null } | null = null;

    if (requestedDate) {
      const windowStart = new Date(requestedDate.getTime() - 30 * 60 * 1000);
      const windowEnd = new Date(requestedDate.getTime() + 30 * 60 * 1000);
      conflict = await prisma.appointmentRequest.findFirst({
        where: {
          therapistNotionId,
          confirmedDateTimeParsed: { gte: windowStart, lte: windowEnd },
          status: { notIn: ['cancelled', 'completed'] },
          id: { not: appointmentId },
        },
        select: { id: true, userName: true },
      });
    }

    // Fallback: exact string match
    if (!conflict) {
      conflict = await prisma.appointmentRequest.findFirst({
        where: {
          therapistNotionId,
          confirmedDateTime,
          status: { notIn: ['cancelled', 'completed'] },
          id: { not: appointmentId },
        },
        select: { id: true, userName: true },
      });
    }

    if (conflict) {
      logger.warn(
        { appointmentId, therapistNotionId, confirmedDateTime, conflictId: conflict.id },
        'Confirmation validation failed: slot already booked'
      );
      return {
        valid: false,
        reason: 'This time slot has already been booked by another client',
        code: 'SLOT_TAKEN',
        details: { conflictingAppointmentId: conflict.id },
      };
    }

    return { valid: true };
  }

  /**
   * Batch validate multiple therapists (useful for frontend display)
   * Returns a map of therapist IDs to their availability status
   */
  async batchValidateTherapists(
    therapistNotionIds: string[]
  ): Promise<Map<string, { available: boolean; reason?: string }>> {
    const results = new Map<string, { available: boolean; reason?: string }>();

    // Get all booking statuses in one query
    const bookingStatuses = await prisma.therapistBookingStatus.findMany({
      where: { id: { in: therapistNotionIds } },
    });

    const statusMap = new Map(bookingStatuses.map(s => [s.id, s]));

    for (const therapistId of therapistNotionIds) {
      const status = statusMap.get(therapistId);

      if (status?.hasConfirmedBooking) {
        results.set(therapistId, {
          available: false,
          reason: 'Has confirmed booking',
        });
      } else if (status && status.uniqueRequestCount >= 2) {
        results.set(therapistId, {
          available: false,
          reason: 'Maximum pending requests reached',
        });
      } else {
        results.set(therapistId, { available: true });
      }
    }

    return results;
  }
}

// Singleton instance
export const bookingValidatorService = new BookingValidatorService();
