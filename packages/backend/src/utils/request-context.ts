/**
 * Request-scoped context propagation via AsyncLocalStorage.
 *
 * Adds an implicit traceId (and optionally appointmentId) to every log
 * line emitted within the scope of a `runWithContext` block, without
 * requiring every function in the call chain to thread it explicitly.
 *
 * Used by:
 *   - Top-level entrance points: HTTP routes, scheduler tasks, message
 *     processor's processMessage()
 *   - The pino logger via a mixin (see logger.ts)
 *
 * Existing code that passes traceId explicitly continues to work
 * unchanged — explicit values in the log payload override the
 * context-derived ones because pino merges in argument order.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestContext {
  traceId: string;
  appointmentId?: string;
  /** Optional source: 'scanner', 'webhook', 'admin', etc. */
  source?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

/**
 * Run `fn` inside a request context. Any logger.* call made by `fn`
 * (or anything `fn` awaits) will automatically pick up the traceId
 * via the pino mixin.
 */
export function runWithContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

/**
 * Read the current context, or undefined if outside a runWithContext scope.
 * The pino mixin uses this; application code should generally pass values
 * explicitly rather than reaching into the context.
 */
export function getContext(): RequestContext | undefined {
  return storage.getStore();
}

/**
 * Mutate the current context to add fields. Useful when an inner layer
 * (e.g. the appointment matcher inside processMessage) discovers the
 * appointmentId after the outer scope was created with only a traceId.
 * Mutates in place — the next log line will pick up the new fields.
 */
export function extendContext(extra: Partial<RequestContext>): void {
  const current = storage.getStore();
  if (current) {
    Object.assign(current, extra);
  }
}
