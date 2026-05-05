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
import { acquireLock, releaseLock } from '../utils/redis-locks';
import { APPOINTMENT_STATUS } from '../constants';
import { appointmentLifecycleService } from './appointment-lifecycle.service';

const TICK_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
const STARTUP_DELAY_MS = 2 * 60 * 1000;  // 2 minutes
const LOCK_TTL_SECONDS = 300;            // 5 minutes
const LOCK_KEY = 'lock:appointment-lifecycle-tick';
const SESSION_END_BUFFER_MS = 60 * 60 * 1000; // 1 hour
const BATCH_SIZE = 50;

class AppointmentLifecycleTickService {
  private intervalId: NodeJS.Timeout | null = null;
  private startupTimeout: NodeJS.Timeout | null = null;
  private running = false;
  private instanceId: string;
  private lastRun: { time: Date; transitioned: number } | null = null;

  constructor() {
    this.instanceId = `${process.pid}-${Date.now().toString(36)}-lifecycle-tick`;
  }

  start(): void {
    logger.info('Starting appointment lifecycle tick');
    this.startupTimeout = setTimeout(() => {
      this.startupTimeout = null;
      this.runWithLock();
    }, STARTUP_DELAY_MS);
    this.intervalId = setInterval(() => this.runWithLock(), TICK_INTERVAL_MS);
  }

  stop(): void {
    if (this.startupTimeout) {
      clearTimeout(this.startupTimeout);
      this.startupTimeout = null;
    }
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    logger.info('Stopped appointment lifecycle tick');
  }

  /** Manual trigger used by the admin diagnostics endpoint. */
  async trigger(): Promise<{ transitioned: number; skipped?: boolean }> {
    return this.runWithLock();
  }

  getStatus() {
    return {
      running: this.running,
      intervalMs: TICK_INTERVAL_MS,
      lastRun: this.lastRun?.time ?? null,
      lastTransitioned: this.lastRun?.transitioned ?? null,
    };
  }

  private async runWithLock(): Promise<{ transitioned: number; skipped?: boolean }> {
    if (this.running) {
      return { transitioned: 0, skipped: true };
    }

    const acquired = await acquireLock(LOCK_KEY, this.instanceId, LOCK_TTL_SECONDS);
    if (!acquired) {
      return { transitioned: 0, skipped: true };
    }

    this.running = true;
    try {
      const transitioned = await this.runOnce();
      this.lastRun = { time: new Date(), transitioned };
      return { transitioned };
    } catch (err) {
      logger.error({ err }, 'Appointment lifecycle tick failed');
      return { transitioned: 0 };
    } finally {
      await releaseLock(LOCK_KEY, this.instanceId, 'lifecycle-tick');
      this.running = false;
    }
  }

  private async runOnce(): Promise<number> {
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

    if (appointments.length === 0) return 0;

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

    return transitioned;
  }
}

export const appointmentLifecycleTickService = new AppointmentLifecycleTickService();
