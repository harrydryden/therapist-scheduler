import { AsyncLocalStorage } from 'node:async_hooks';
import { logger } from './logger';

/**
 * Lightweight request tracing using AsyncLocalStorage.
 *
 * Propagates trace context through async operations without parameter passing.
 * Each incoming request (or background task) gets a trace ID that flows
 * through every service call it makes. The pino logger reads from this
 * store on every log call, so any log line emitted within a runWithTrace
 * scope automatically picks up traceId/appointmentId/source.
 *
 * Usage:
 *   - HTTP requests: trace ID is set automatically by the Fastify hook
 *     registered in server.ts (full TraceContext with method/url/startTime).
 *   - Background tasks (message processor, scanner): use runWithTrace with
 *     a minimal { traceId, source } context.
 *   - Access current trace via getTraceContext() from anywhere in the
 *     call stack. Most code shouldn't need to — pass values explicitly.
 *   - Mutate the current scope mid-flight via extendTraceContext (e.g.
 *     to add the appointmentId once it's been matched).
 */

export interface TraceContext {
  traceId: string;
  /** HTTP-only fields, omitted for background tasks. */
  requestId?: string;
  method?: string;
  url?: string;
  startTime?: number;
  /** Optional context for background processing. */
  appointmentId?: string;
  /** Set by the inbound dispatcher when the email matches a
   *  therapist-only conversation (availability-collection agent). */
  therapistConversationId?: string;
  source?: string;
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
 * Run a function within a trace context. Used by both the Fastify request
 * hook and by background tasks (message processor, scanner) to scope a
 * unit of work.
 */
export function runWithTrace<T>(context: TraceContext, fn: () => T): T {
  return traceStorage.run(context, fn);
}

/**
 * Mutate the current trace context to add fields. Useful when an inner
 * layer (e.g. the appointment matcher inside processMessage) discovers a
 * value after the outer scope was created. Mutates in place — the next
 * log line will pick up the new fields. No-op outside any scope.
 */
export function extendTraceContext(extra: Partial<TraceContext>): void {
  const current = traceStorage.getStore();
  if (current) {
    Object.assign(current, extra);
  }
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
 * Log request completion with timing metrics.
 * Called by the Fastify onResponse hook.
 */
export function logRequestMetrics(statusCode: number) {
  const ctx = getTraceContext();
  if (!ctx || ctx.startTime === undefined) return;

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
