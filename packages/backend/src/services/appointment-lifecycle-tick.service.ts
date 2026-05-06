/**
 * Appointment Lifecycle Tick Service
 *
 * Periodic background task that transitions `confirmed` appointments to
 * `session_held` once the scheduled session time has passed (with a one-hour
 * buffer to allow for sessions that run long).
 *
 * Previously lived inside notion-sync-manager.service.ts because it shared
 * the manager's distributed-lock plumbing, but the work itself has nothing
 * to do with Notion. Extracted here as part of PR 2 of the Notion
 * deprecation so the sync manager can be deleted.
 *
 * Runs every 30 minutes; each transition uses atomic preconditions, so
 * multiple instances racing on the same appointment is safe.
 */

import { prisma } from '../utils/database';
import { logger } from '../utils/logger';
import { LockedPeriodicService } from '../utils/locked-periodic-service';
import { APPOINTMENT_STATUS } from '../constants';
import { appointmentLifecycleService } from './appointment-lifecycle.service';

const TICK_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
const STARTUP_DELAY_MS = 2 * 60 * 1000;  // 2 minutes
const LOCK_TTL_SECONDS = 300;            // 5 minutes
const RENEWAL_INTERVAL_MS = 30 * 1000;   // 30 seconds
const LOCK_KEY = 'lock:appointment-lifecycle-tick';
const SESSION_END_BUFFER_MS = 60 * 60 * 1000; // 1 hour
const BATCH_SIZE = 50;

interface TickResult {
  transitioned: number;
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
      select: { id: true },
      take: BATCH_SIZE,
    });

    if (appointments.length === 0) return { transitioned: 0 };

    let transitioned = 0;

    const results = await Promise.allSettled(
      appointments.map(async (apt) => {
        const result = await appointmentLifecycleService.transitionToSessionHeld({
          appointmentId: apt.id,
          source: 'system',
        });
        return { id: apt.id, skipped: result.skipped };
      }),
    );

    for (const result of results) {
      if (result.status === 'fulfilled' && !result.value.skipped) {
        logger.info({ appointmentId: result.value.id }, 'Transitioned to session_held');
        transitioned++;
      } else if (result.status === 'rejected') {
        logger.error({ error: result.reason }, 'Failed to transition to session_held');
      }
    }

    return { transitioned };
  }
}

export const appointmentLifecycleTickService = new AppointmentLifecycleTickService();
