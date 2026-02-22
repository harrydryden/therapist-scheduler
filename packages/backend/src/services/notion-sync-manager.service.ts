/**
 * Notion Sync Manager
 *
 * Unified service that coordinates all Notion synchronization operations.
 * Consolidates multiple sync services into a single manager with:
 * - Shared Notion client with rate limiting
 * - Coordinated scheduling to prevent overlapping syncs
 * - Centralized distributed locking
 * - Unified logging and status reporting
 *
 * Sync Operations:
 * 1. Therapist Freeze Sync (TO Notion) - Every 5 min
 *    - Syncs freeze status from PostgreSQL to Notion therapist database
 *
 * 2. User Sync (TO Notion) - Every 6 hours
 *    - Syncs user data to Notion users database
 *
 * 3. Feedback Write Sync (TO Notion) - Every 5 min
 *    - Writes native feedback form submissions to Notion
 *
 * 4. Feedback Read Sync (FROM Notion) - Every 30 min
 *    - Reads feedback entries from Notion to mark appointments completed
 */

import { notionClientManager } from '../utils/notion-client';
import { redis } from '../utils/redis';
import { logger } from '../utils/logger';
import { releaseLock, acquireLock } from '../utils/redis-locks';
import { prisma } from '../utils/database';
import { config } from '../config';
import { APPOINTMENT_STATUS } from '../constants';
import { appointmentLifecycleService } from './appointment-lifecycle.service';
import { therapistBookingStatusService } from './therapist-booking-status.service';
import { notionService } from './notion.service';
import { notionUsersService } from './notion-users.service';

// ============================================
// Configuration
// ============================================

const SYNC_INTERVALS = {
  therapistFreeze: 5 * 60 * 1000,      // 5 minutes
  appointmentLifecycle: 30 * 60 * 1000, // 30 minutes (transitions confirmed → session_held)
  userSync: 6 * 60 * 60 * 1000,        // 6 hours
};

const STARTUP_DELAYS = {
  therapistFreeze: 0,                   // Immediately
  appointmentLifecycle: 2 * 60 * 1000,  // 2 minutes
  userSync: 30 * 1000,                 // 30 seconds
};

const LOCK_CONFIG = {
  prefix: 'lock:notion-sync:',
  ttlSeconds: 300, // 5 minutes
};

// ============================================
// Types
// ============================================

interface SyncResult {
  synced: number;
  errors: number;
  skipped?: boolean;
  message?: string;
}

interface SyncStatus {
  name: string;
  enabled: boolean;
  running: boolean;
  intervalMs: number;
  lastRun: Date | null;
  lastResult: SyncResult | null;
}

type SyncType = 'therapistFreeze' | 'appointmentLifecycle' | 'userSync';

// ============================================
// Notion Sync Manager
// ============================================

class NotionSyncManager {
  private instanceId: string;
  private intervals: Map<SyncType, NodeJS.Timeout> = new Map();
  private startupTimeouts: Map<SyncType, NodeJS.Timeout> = new Map();
  private runningTasks: Set<SyncType> = new Set();
  private lastResults: Map<SyncType, { time: Date; result: SyncResult }> = new Map();
  constructor() {
    this.instanceId = `${process.pid}-${Date.now().toString(36)}-notion-sync`;
  }

  // ============================================
  // Lifecycle
  // ============================================

  /**
   * Start all configured sync operations
   */
  start(): void {
    logger.info('Starting Notion Sync Manager');

    // Start each sync type with its configured delay and interval
    this.startSyncType('therapistFreeze', () => this.syncTherapistFreeze());
    this.startSyncType('userSync', () => this.syncUsers());
    this.startSyncType('appointmentLifecycle', () => this.runAppointmentLifecycleTick());

    logger.info({
      therapistFreeze: `${SYNC_INTERVALS.therapistFreeze / 1000}s`,
      appointmentLifecycle: `${SYNC_INTERVALS.appointmentLifecycle / 1000}s`,
      userSync: `${SYNC_INTERVALS.userSync / 1000}s`,
    }, 'Notion Sync Manager started with intervals');
  }

  /**
   * Stop all sync operations
   */
  stop(): void {
    logger.info('Stopping Notion Sync Manager');

    // Clear startup timeouts
    for (const [, timeoutId] of this.startupTimeouts) {
      clearTimeout(timeoutId);
    }
    this.startupTimeouts.clear();

    // Clear recurring intervals
    for (const [, intervalId] of this.intervals) {
      clearInterval(intervalId);
    }
    this.intervals.clear();

    logger.info('Notion Sync Manager stopped');
  }

  /**
   * Get status of all sync operations
   */
  getStatus(): SyncStatus[] {
    return [
      this.getSyncStatus('therapistFreeze', 'Therapist Freeze Sync'),
      this.getSyncStatus('userSync', 'User Sync'),
      this.getSyncStatus('appointmentLifecycle', 'Appointment Lifecycle Tick'),
    ];
  }

  // ============================================
  // Manual Triggers
  // ============================================

  async triggerTherapistFreezeSync(): Promise<SyncResult> {
    return this.runWithLock('therapistFreeze', () => this.syncTherapistFreeze());
  }

  async triggerUserSync(): Promise<SyncResult> {
    return this.runWithLock('userSync', () => this.syncUsers());
  }

  async triggerAppointmentLifecycleTick(): Promise<SyncResult> {
    return this.runWithLock('appointmentLifecycle', () => this.runAppointmentLifecycleTick());
  }

  /**
   * Sync a single therapist's freeze status (on-demand)
   */
  async syncSingleTherapist(therapistId: string): Promise<void> {
    try {
      const shouldBeFrozen = await therapistBookingStatusService.shouldTherapistBeFrozen(therapistId);
      await notionService.updateTherapistFrozen(therapistId, shouldBeFrozen);
      logger.info({ therapistId, frozen: shouldBeFrozen }, 'Synced single therapist freeze status');
    } catch (error) {
      logger.error({ error, therapistId }, 'Failed to sync single therapist freeze status');
    }
  }

  /**
   * Sync a single user (on-demand, e.g., after appointment confirmation)
   */
  async syncSingleUser(email: string): Promise<void> {
    if (!notionUsersService.isConfigured()) {
      return;
    }

    try {
      await notionUsersService.syncUser(email);
      logger.debug({ email }, 'Synced single user to Notion');
    } catch (error) {
      logger.error({ error, email }, 'Failed to sync single user');
    }
  }

  // ============================================
  // Private: Scheduling Infrastructure
  // ============================================

  private startSyncType(type: SyncType, syncFn: () => Promise<SyncResult>): void {
    const interval = SYNC_INTERVALS[type];
    const delay = STARTUP_DELAYS[type];

    // Check if this sync type is enabled
    if (!this.isSyncEnabled(type)) {
      logger.info({ syncType: type }, 'Sync type disabled - not configured');
      return;
    }

    // Schedule initial run
    const timeoutId = setTimeout(() => {
      this.startupTimeouts.delete(type);
      this.runWithLock(type, syncFn);
    }, delay);
    this.startupTimeouts.set(type, timeoutId);

    // Schedule periodic runs
    const intervalId = setInterval(() => {
      this.runWithLock(type, syncFn);
    }, interval);

    this.intervals.set(type, intervalId);
    logger.debug({ syncType: type, intervalMs: interval, delayMs: delay }, 'Scheduled sync type');
  }

  private isSyncEnabled(type: SyncType): boolean {
    switch (type) {
      case 'therapistFreeze':
        return notionClientManager.isConfigured();
      case 'userSync':
        return notionUsersService.isConfigured();
      case 'appointmentLifecycle':
        return true; // Always enabled — transitions confirmed → session_held
      default:
        return false;
    }
  }

  private getSyncStatus(type: SyncType, name: string): SyncStatus {
    const lastRun = this.lastResults.get(type);
    return {
      name,
      enabled: this.isSyncEnabled(type),
      running: this.runningTasks.has(type),
      intervalMs: SYNC_INTERVALS[type],
      lastRun: lastRun?.time || null,
      lastResult: lastRun?.result || null,
    };
  }

  // ============================================
  // Private: Locking & Execution
  // ============================================

  private async runWithLock(type: SyncType, syncFn: () => Promise<SyncResult>): Promise<SyncResult> {
    // Check local running state
    if (this.runningTasks.has(type)) {
      logger.debug({ syncType: type }, 'Sync already running locally, skipping');
      return { synced: 0, errors: 0, skipped: true, message: 'Already running' };
    }

    // Try to acquire distributed lock
    const lockKey = `${LOCK_CONFIG.prefix}${type}`;
    const lockAcquired = await this.tryAcquireLock(lockKey);

    if (!lockAcquired) {
      logger.debug({ syncType: type }, 'Sync lock held by another instance, skipping');
      return { synced: 0, errors: 0, skipped: true, message: 'Lock held by another instance' };
    }

    this.runningTasks.add(type);
    const startTime = Date.now();

    try {
      const result = await syncFn();

      // Store result
      this.lastResults.set(type, { time: new Date(), result });

      const durationMs = Date.now() - startTime;
      logger.debug({ syncType: type, durationMs, result }, 'Sync completed');

      return result;
    } catch (error) {
      logger.error({ error, syncType: type }, 'Sync failed with unhandled error');
      return { synced: 0, errors: 1, message: error instanceof Error ? error.message : 'Unknown error' };
    } finally {
      await this.releaseSyncLock(lockKey);
      this.runningTasks.delete(type);
    }
  }

  private async tryAcquireLock(lockKey: string): Promise<boolean> {
    return acquireLock(lockKey, this.instanceId, LOCK_CONFIG.ttlSeconds);
  }

  private async releaseSyncLock(lockKey: string): Promise<void> {
    await releaseLock(lockKey, this.instanceId, 'notion-sync');
  }

  // ============================================
  // Sync Implementations
  // ============================================

  /**
   * Sync therapist freeze status TO Notion
   */
  private async syncTherapistFreeze(): Promise<SyncResult> {
    const syncId = Date.now().toString(36);
    logger.info({ syncId }, 'Running therapist freeze sync');

    let synced = 0;
    let errors = 0;

    try {
      const statuses = await therapistBookingStatusService.getAllStatuses();
      logger.debug({ syncId, count: statuses.length }, 'Found therapists to sync');

      // OPTIMIZATION: Batch compute freeze status instead of N+1 queries
      const therapistIds = statuses.map(s => s.id);
      const freezeStatusMap = await therapistBookingStatusService.batchComputeFreezeStatus(therapistIds);

      for (const status of statuses) {
        try {
          const shouldBeFrozen = freezeStatusMap.get(status.id) ?? false;

          await notionClientManager.executeWithRateLimit(async () => {
            await notionService.updateTherapistFrozen(status.id, shouldBeFrozen);
          });

          synced++;
        } catch (error) {
          logger.error({ error, therapistId: status.id }, 'Failed to sync therapist freeze status');
          errors++;
        }
      }

      logger.info({ syncId, synced, errors }, 'Therapist freeze sync completed');
    } catch (error) {
      logger.error({ syncId, error }, 'Therapist freeze sync failed');
      errors++;
    }

    return { synced, errors };
  }

  /**
   * Sync users TO Notion
   */
  private async syncUsers(): Promise<SyncResult> {
    const syncId = Date.now().toString(36);
    logger.info({ syncId }, 'Running user sync');

    try {
      const result = await notionUsersService.syncAllUsers();
      logger.info({ syncId, ...result }, 'User sync completed');
      return { synced: result.synced, errors: result.failed };
    } catch (error) {
      logger.error({ syncId, error }, 'User sync failed');
      return { synced: 0, errors: 1 };
    }
  }

  /**
   * Periodic lifecycle tick: transitions confirmed appointments to session_held
   * after the session time has passed.
   */
  private async runAppointmentLifecycleTick(): Promise<SyncResult> {
    const syncId = Date.now().toString(36);
    logger.info({ syncId }, 'Running appointment lifecycle tick');

    let synced = 0;
    let errors = 0;

    try {
      const sessionHeldCount = await this.transitionToSessionHeld(syncId);
      synced += sessionHeldCount;
      logger.info({ syncId, sessionHeldCount }, 'Appointment lifecycle tick completed');
    } catch (error) {
      logger.error({ syncId, error }, 'Appointment lifecycle tick failed');
      errors++;
    }

    return { synced, errors };
  }

  // ============================================
  // Private: Appointment Lifecycle Helpers
  // ============================================

  private async transitionToSessionHeld(syncId: string): Promise<number> {
    const now = new Date();
    const sessionEndBuffer = new Date(now.getTime() - 60 * 60 * 1000);

    const appointments = await prisma.appointmentRequest.findMany({
      where: {
        status: APPOINTMENT_STATUS.CONFIRMED,
        confirmedDateTimeParsed: {
          not: null,
          lt: sessionEndBuffer,
        },
      },
      select: {
        id: true,
        userEmail: true,
        userName: true,
        therapistName: true,
      },
      take: 50,
    });

    if (appointments.length === 0) return 0;

    let transitioned = 0;

    for (const apt of appointments) {
      try {
        const result = await appointmentLifecycleService.transitionToSessionHeld({
          appointmentId: apt.id,
          source: 'system',
        });

        if (!result.skipped) {
          logger.info({ syncId, appointmentId: apt.id }, 'Transitioned to session_held');
          transitioned++;
        }
      } catch (error) {
        logger.error({ syncId, appointmentId: apt.id, error }, 'Failed to transition to session_held');
      }
    }

    return transitioned;
  }

}

// Singleton export
export const notionSyncManager = new NotionSyncManager();
