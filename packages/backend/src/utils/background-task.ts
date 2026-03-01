/**
 * Background Task Utility
 *
 * Provides tracked execution of fire-and-forget operations with:
 * - Timeout protection to prevent hanging
 * - Guaranteed error logging even if handler fails
 * - Metrics collection for success/failure rates
 * - Optional retry capability
 *
 * Use this for non-critical side effects like:
 * - Slack notifications
 * - User sync to Notion
 * - Audit logging
 * - Email sends (when not blocking on result)
 */

import { logger } from './logger';
import { DEFAULT_TIMEOUTS } from './timeout';

export interface BackgroundTaskOptions {
  /** Name of the task for logging/metrics */
  name: string;
  /** Timeout in milliseconds (default: 30s) */
  timeoutMs?: number;
  /** Context for logging */
  context?: Record<string, unknown>;
  /** Whether to retry on failure (default: false) */
  retry?: boolean;
  /** Max retry attempts if retry is true (default: 2) */
  maxRetries?: number;
  /** Delay between retries in ms (default: 1000) */
  retryDelayMs?: number;
}

interface TaskMetrics {
  total: number;
  success: number;
  failed: number;
  timedOut: number;
  recentErrors: Array<{
    timestamp: Date;
    error: string;
    context?: Record<string, unknown>;
  }>;
}

// In-memory metrics (could be extended to Redis/Prometheus)
const taskMetrics: Map<string, TaskMetrics> = new Map();

// Maximum recent errors to keep per task
const MAX_RECENT_ERRORS = 10;

// Track when we last logged a summary
let lastSummaryTime = Date.now();
const SUMMARY_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Get metrics for a specific task type
 */
export function getTaskMetrics(taskName: string): TaskMetrics | undefined {
  return taskMetrics.get(taskName);
}

/**
 * Get all task metrics
 */
export function getAllTaskMetrics(): Record<string, TaskMetrics> {
  const result: Record<string, TaskMetrics> = {};
  taskMetrics.forEach((metrics, name) => {
    result[name] = { ...metrics };
  });
  return result;
}

function getOrCreateMetrics(taskName: string): TaskMetrics {
  let metrics = taskMetrics.get(taskName);
  if (!metrics) {
    metrics = { total: 0, success: 0, failed: 0, timedOut: 0, recentErrors: [] };
    taskMetrics.set(taskName, metrics);
  }
  return metrics;
}

/**
 * Record an error for a task (keeps last N errors)
 */
function recordTaskError(
  metrics: TaskMetrics,
  error: string,
  context?: Record<string, unknown>
): void {
  metrics.recentErrors.push({
    timestamp: new Date(),
    error,
    context,
  });

  // Keep only the most recent errors
  while (metrics.recentErrors.length > MAX_RECENT_ERRORS) {
    metrics.recentErrors.shift();
  }
}

/**
 * Check if we should log a summary and do so if needed
 */
function maybeLogSummary(): void {
  const now = Date.now();
  if (now - lastSummaryTime < SUMMARY_INTERVAL_MS) {
    return;
  }
  lastSummaryTime = now;

  // Calculate summary stats
  let totalFailed = 0;
  let totalTimedOut = 0;
  const failingTasks: Array<{ name: string; failed: number; timedOut: number }> = [];

  for (const [name, metrics] of taskMetrics) {
    if (metrics.failed > 0 || metrics.timedOut > 0) {
      totalFailed += metrics.failed;
      totalTimedOut += metrics.timedOut;
      failingTasks.push({
        name,
        failed: metrics.failed,
        timedOut: metrics.timedOut,
      });
    }
  }

  // Only log if there are failures
  if (totalFailed > 0 || totalTimedOut > 0) {
    logger.warn(
      {
        totalFailed,
        totalTimedOut,
        failingTasks,
        intervalMinutes: SUMMARY_INTERVAL_MS / 60000,
      },
      'Background task failure summary'
    );
  }
}

/**
 * Get a health summary of all background tasks
 * Useful for health check endpoints
 */
export function getBackgroundTaskHealth(): {
  healthy: boolean;
  tasks: Record<string, {
    total: number;
    successRate: number;
    recentErrors: number;
  }>;
} {
  const tasks: Record<string, { total: number; successRate: number; recentErrors: number }> = {};
  let hasFailures = false;

  for (const [name, metrics] of taskMetrics) {
    const successRate = metrics.total > 0
      ? Math.round((metrics.success / metrics.total) * 100)
      : 100;

    // Count errors in last 5 minutes
    const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;
    const recentErrors = metrics.recentErrors.filter(
      e => e.timestamp.getTime() > fiveMinutesAgo
    ).length;

    tasks[name] = {
      total: metrics.total,
      successRate,
      recentErrors,
    };

    if (recentErrors > 0) {
      hasFailures = true;
    }
  }

  return { healthy: !hasFailures, tasks };
}

/**
 * Execute a fire-and-forget task with tracking
 *
 * This function:
 * 1. Does NOT block the caller (returns void immediately)
 * 2. Tracks success/failure metrics
 * 3. Enforces timeout to prevent hanging
 * 4. Guarantees error logging
 *
 * @example
 * // Fire and forget a Slack notification
 * runBackgroundTask(
 *   () => slackService.notify(message),
 *   { name: 'slack-notify', context: { appointmentId } }
 * );
 */
export function runBackgroundTask(
  task: () => Promise<unknown>,
  options: BackgroundTaskOptions
): void {
  const {
    name,
    timeoutMs = DEFAULT_TIMEOUTS.EXTERNAL_API,
    context = {},
    retry = false,
    maxRetries = 2,
    retryDelayMs = 1000,
  } = options;

  const metrics = getOrCreateMetrics(name);
  metrics.total++;

  const executeTask = async (attempt: number = 1): Promise<void> => {
    const startTime = Date.now();

    try {
      // Create timeout promise with clearable timer to prevent timer leak
      let timeoutHandle: ReturnType<typeof setTimeout>;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          reject(new Error(`Background task '${name}' timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      });

      // Race task against timeout, then clear the timer
      try {
        await Promise.race([task(), timeoutPromise]);
      } finally {
        clearTimeout(timeoutHandle!);
      }

      const duration = Date.now() - startTime;
      metrics.success++;

      logger.debug(
        { taskName: name, duration, attempt, ...context },
        'Background task completed'
      );
    } catch (error) {
      const duration = Date.now() - startTime;
      const isTimeout = error instanceof Error && error.message.includes('timed out');

      if (isTimeout) {
        metrics.timedOut++;
      }

      // Retry logic
      if (retry && attempt < maxRetries && !isTimeout) {
        logger.warn(
          { taskName: name, attempt, maxRetries, error, ...context },
          'Background task failed, retrying'
        );

        await new Promise(resolve => setTimeout(resolve, retryDelayMs));
        return executeTask(attempt + 1);
      }

      metrics.failed++;

      // Record error for aggregation
      const errorMessage = error instanceof Error ? error.message : String(error);
      recordTaskError(metrics, errorMessage, context);

      // Guaranteed error logging
      logger.error(
        {
          taskName: name,
          duration,
          attempt,
          isTimeout,
          error: errorMessage,
          stack: error instanceof Error ? error.stack : undefined,
          ...context,
        },
        `Background task '${name}' failed`
      );

      // Check if we should log a periodic summary
      maybeLogSummary();
    }
  };

  // Start execution without blocking
  // Use setImmediate to ensure we don't block the event loop
  setImmediate(() => {
    executeTask().catch((err) => {
      // This catch should never trigger, but just in case
      logger.error(
        { taskName: name, error: err, ...context },
        'Unexpected error in background task execution'
      );
    });
  });
}

