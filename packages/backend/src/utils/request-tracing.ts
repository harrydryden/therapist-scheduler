import { AsyncLocalStorage } from 'node:async_hooks';
import { logger } from './logger';

/**
 * Lightweight request tracing using AsyncLocalStorage
 *
 * Propagates trace context through async operations without parameter passing.
 * Each incoming request gets a trace ID that flows through all service calls.
 *
 * Usage:
 *   - Trace ID is set automatically by the Fastify hook registered in server.ts
 *   - Access current trace via getTraceContext() from anywhere in the call stack
 *   - External services receive trace ID via X-Trace-ID header
 */

export interface TraceContext {
  traceId: string;
  requestId: string;
  method: string;
  url: string;
  startTime: number;
}

const traceStorage = new AsyncLocalStorage<TraceContext>();

/**
 * Get the current trace context from the async call stack.
 * Returns undefined if called outside a traced request.
 */
export function getTraceContext(): TraceContext | undefined {
  return traceStorage.getStore();
}

/**
 * Get just the trace ID, or a fallback for untraced contexts (background jobs).
 */
export function getTraceId(): string {
  return traceStorage.getStore()?.traceId ?? 'no-trace';
}

/**
 * Run a function within a trace context.
 * Used by the Fastify hook to wrap request handling.
 */
export function runWithTrace<T>(context: TraceContext, fn: () => T): T {
  return traceStorage.run(context, fn);
}

/**
 * Generate a trace ID. Uses the Fastify request ID if available,
 * otherwise generates a random hex string.
 */
export function generateTraceId(requestId?: string): string {
  if (requestId) return `req-${requestId}`;
  const hex = Math.random().toString(16).substring(2, 10);
  return `bg-${hex}`;
}

/**
 * Create a child logger with trace context automatically attached.
 * Useful for services that want structured logging with trace info.
 */
export function getTracedLogger() {
  const ctx = getTraceContext();
  if (!ctx) return logger;
  return logger.child({ traceId: ctx.traceId });
}

/**
 * Log request completion with timing metrics.
 * Called by the Fastify onResponse hook.
 */
export function logRequestMetrics(statusCode: number) {
  const ctx = getTraceContext();
  if (!ctx) return;

  const durationMs = Date.now() - ctx.startTime;

  // Log slow requests at warn level for monitoring
  const logLevel = durationMs > 5000 ? 'warn' : 'info';
  const logData = {
    traceId: ctx.traceId,
    method: ctx.method,
    url: ctx.url,
    statusCode,
    durationMs,
  };

  if (logLevel === 'warn') {
    logger.warn(logData, `Slow request: ${ctx.method} ${ctx.url} took ${durationMs}ms`);
  } else {
    logger.debug(logData, `${ctx.method} ${ctx.url} ${statusCode} ${durationMs}ms`);
  }
}
