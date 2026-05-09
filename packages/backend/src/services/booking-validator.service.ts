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
import { therapistBookingStatusService } from './therapist-booking-status.service';
import { logger } from '../utils/logger';
import { parseConfirmedDateTime } from '../utils/date';

export interface ValidationResult {
  valid: boolean;
  reason?: string;
  code?: 'NOT_FOUND' | 'FROZEN' | 'INACTIVE' | 'NO_EMAIL' | 'SLOT_TAKEN' | 'RECENT_BOOKING' | 'RATE_LIMITED';
  details?: Record<string, unknown>;
}

export interface ValidateBookingParams {
  therapistHandle: string;
  userEmail: string;
  /** Optional: check if specific time slot is available */
  confirmedDateTime?: string;
  /**
   * Legacy parameter from when therapist data lived in Notion's cache. Kept
   * for callsite compatibility but no longer has any effect — Postgres reads
   * are always fresh.
   */
  bypassCache?: boolean;
}

class BookingValidatorService {
  /**
   * Validate that a therapist can accept a new booking
   * This is the primary validation called before creating an appointment
   */
  async validateTherapistAvailability(params: ValidateBookingParams): Promise<ValidationResult> {
    const { therapistHandle, userEmail, confirmedDateTime } = params;
    const logContext = { therapistHandle, userEmail };

    try {
      // 1. Check if therapist exists. The public-facing identifier is either
      // the legacy notionId or the Postgres uuid for post-Notion ingestions —
      // accept either.
      const therapist = await prisma.therapist.findFirst({
        where: { OR: [{ notionId: therapistHandle }, { id: therapistHandle }] },
        select: { active: true, email: true },
      });

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

      // 3. Check if therapist has email (required for communication)
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
        therapistHandle,
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
        const slotConflict = await this.checkSlotConflict(therapistHandle, confirmedDateTime);
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
      const recentBooking = await this.checkRecentBookings(therapistHandle, userEmail);
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
        'Booking validation error - failing closed to avoid bypassing therapist freeze'
      );
      // SECURITY: fail closed. The previous fail-open posture meant a
      // Postgres degradation opened a window where any therapist —
      // including frozen ones — could be booked, undermining the freeze
      // logic that prevents over-booking and double-matching. The
      // downstream serializable transaction in appointments.routes.ts
      // is also Postgres-dependent; if validation here can't reach the
      // DB, that transaction can't either, so refusing the booking is
      // the safer default.
      return {
        valid: false,
        reason: 'Booking validation is temporarily unavailable. Please try again in a moment.',
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
    therapistHandle: string,
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
          therapistHandle,
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
        therapistHandle,
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
    therapistHandle: string,
    userEmail: string
  ): Promise<{ id: string } | null> {
    const fiveSecondsAgo = new Date(Date.now() - 5000);

    const recent = await prisma.appointmentRequest.findFirst({
      where: {
        therapistHandle,
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
    therapistHandle: string,
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
          therapistHandle,
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
          therapistHandle,
          confirmedDateTime,
          status: { notIn: ['cancelled', 'completed'] },
          id: { not: appointmentId },
        },
        select: { id: true, userName: true },
      });
    }

    if (conflict) {
      logger.warn(
        { appointmentId, therapistHandle, confirmedDateTime, conflictId: conflict.id },
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
    therapistHandles: string[]
  ): Promise<Map<string, { available: boolean; reason?: string }>> {
    const results = new Map<string, { available: boolean; reason?: string }>();

    // Get all booking statuses in one query
    const bookingStatuses = await prisma.therapistBookingStatus.findMany({
      where: { id: { in: therapistHandles } },
    });

    const statusMap = new Map(bookingStatuses.map(s => [s.id, s]));

    for (const therapistId of therapistHandles) {
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
