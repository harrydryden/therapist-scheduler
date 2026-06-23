/**
 * Periodic background task that transitions `confirmed` appointments to
 * `session_held` once the scheduled session time has passed (with a
 * one-hour buffer to allow for sessions that run long).
 *
 * Runs every 30 minutes; each transition uses atomic preconditions, so
 * multiple instances racing on the same appointment is safe.
 */

import { prisma } from '../../../utils/database';
import { logger } from '../../../utils/logger';
import { LockedPeriodicService } from '../../../utils/locked-periodic-service';
import { APPOINTMENT_STATUS } from '../../../constants';
import { transitionToSessionHeld } from './transitions/light';
import { auditEventService } from '../../../services/audit-event.service';

const TICK_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
const STARTUP_DELAY_MS = 2 * 60 * 1000;  // 2 minutes
const LOCK_TTL_SECONDS = 300;            // 5 minutes
const RENEWAL_INTERVAL_MS = 30 * 1000;   // 30 seconds
const LOCK_KEY = 'lock:appointment-lifecycle-tick';
const SESSION_END_BUFFER_MS = 60 * 60 * 1000; // 1 hour
const BATCH_SIZE = 50;

interface TickResult {
  transitioned: number;
  /**
   * Of the appointments transitioned to session_held this tick, how many
   * had no verified meeting link (meetingLinkConfirmedAt was null). These
   * are sessions the system is asserting purely because the scheduled time
   * passed — they may never have actually occurred. Surfaced for health
   * monitoring and audited per-appointment.
   */
  unverifiedHeld: number;
}

class AppointmentLifecycleTickService extends LockedPeriodicService<TickResult> {
  constructor() {
    super({
      name: 'appointment-lifecycle-tick',
      intervalMs: TICK_INTERVAL_MS,
      startupDelayMs: STARTUP_DELAY_MS,
      lockKey: LOCK_KEY,
      lockTtlSeconds: LOCK_TTL_SECONDS,
      renewalIntervalMs: RENEWAL_INTERVAL_MS,
    });
  }

  protected async tick(): Promise<TickResult> {
    const sessionEndBuffer = new Date(Date.now() - SESSION_END_BUFFER_MS);

    const appointments = await prisma.appointmentRequest.findMany({
      where: {
        status: APPOINTMENT_STATUS.CONFIRMED,
        confirmedDateTimeParsed: {
          not: null,
          lt: sessionEndBuffer,
        },
      },
      // meetingLinkConfirmedAt is the truth gate: null means we never saw an
      // actual meeting link for this booking, so promoting it to session_held
      // is an assertion driven only by the clock, not by evidence the session
      // was set up.
      select: { id: true, meetingLinkConfirmedAt: true, confirmedDateTime: true },
      take: BATCH_SIZE,
    });

    if (appointments.length === 0) return { transitioned: 0, unverifiedHeld: 0 };

    let transitioned = 0;
    let unverifiedHeld = 0;

    const results = await Promise.allSettled(
      appointments.map(async (apt) => {
        const result = await transitionToSessionHeld({
          appointmentId: apt.id,
          source: 'system',
        });
        return {
          id: apt.id,
          skipped: result.skipped,
          meetingLinkConfirmed: apt.meetingLinkConfirmedAt != null,
          confirmedDateTime: apt.confirmedDateTime,
        };
      }),
    );

    // Audit writes for unverified holds are fire-and-forget-safe
    // (auditEventService.log swallows its own errors) but we await them so
    // the records land before the tick's lock TTL can lapse.
    const auditWrites: Promise<void>[] = [];

    for (const result of results) {
      if (result.status === 'fulfilled' && !result.value.skipped) {
        transitioned++;
        if (result.value.meetingLinkConfirmed) {
          logger.info({ appointmentId: result.value.id }, 'Transitioned to session_held');
        } else {
          // The session time passed but we never recorded a real meeting
          // link. Don't silently treat it as held — log loudly and leave an
          // audit trail so an admin can confirm the session actually happened
          // before the feedback flow runs. (We still transition: blocking on
          // a heuristic signal risks stranding legitimate bookings whose link
          // was sent out-of-band.)
          unverifiedHeld++;
          logger.warn(
            { appointmentId: result.value.id },
            'Transitioned to session_held WITHOUT a verified meeting link — session may not have occurred',
          );
          auditWrites.push(
            auditEventService.log(result.value.id, 'session_held_unverified', 'system', {
              confirmedDateTime: result.value.confirmedDateTime,
              note:
                'Auto-transitioned to session_held on schedule, but no meeting link was ever ' +
                'recorded for this booking. Confirm the session took place before relying on feedback.',
            }),
          );
        }
      } else if (result.status === 'rejected') {
        logger.error({ error: result.reason }, 'Failed to transition to session_held');
      }
    }

    if (auditWrites.length > 0) {
      await Promise.allSettled(auditWrites);
    }

    if (unverifiedHeld > 0) {
      logger.warn(
        { transitioned, unverifiedHeld },
        'Lifecycle tick promoted appointments to session_held without a verified meeting link',
      );
    }

    return { transitioned, unverifiedHeld };
  }
}

export const appointmentLifecycleTickService = new AppointmentLifecycleTickService();
