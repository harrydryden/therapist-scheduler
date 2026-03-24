/**
 * Typed Event Bus
 *
 * Decouples services that would otherwise form circular dependency chains.
 * Services publish domain events; other services subscribe without needing
 * a direct import of the publisher.
 *
 * Primary use case: breaking the circular chain
 *   justin-time → appointment-lifecycle → email-processing → justin-time
 *
 * All event handlers run asynchronously and errors are logged but do not
 * propagate to the publisher (fire-and-forget semantics).
 */

import { logger } from './logger';

// ─── Event Definitions ──────────────────────────────────────────────────────

export interface AppointmentEvents {
  /** Fired when an incoming email needs AI agent processing */
  'email.needs-agent-processing': {
    appointmentId: string;
    messageId: string;
    fromEmail: string;
    subject: string;
    body: string;
    threadId?: string;
    traceId: string;
  };

  /** Fired when an email should be sent (allows queue service to avoid importing processing service) */
  'email.send-requested': {
    to: string;
    subject: string;
    body: string;
    threadId?: string;
    appointmentId?: string;
    traceId: string;
  };

  /** Fired after a status transition completes successfully */
  'appointment.status-changed': {
    appointmentId: string;
    fromStatus: string;
    toStatus: string;
    source: 'agent' | 'admin' | 'system' | 'feedback_sync';
    adminId?: string;
    reason?: string;
  };

  /** Fired when a conversation needs AI follow-up (e.g., after receiving a reply) */
  'conversation.needs-processing': {
    appointmentId: string;
    traceId: string;
  };
}

// ─── Event Bus Implementation ───────────────────────────────────────────────

type EventMap = AppointmentEvents;
type EventName = keyof EventMap;
type EventHandler<T> = (payload: T) => void | Promise<void>;

class EventBus {
  private handlers = new Map<string, Set<EventHandler<unknown>>>();

  /**
   * Subscribe to an event. Returns an unsubscribe function.
   */
  on<E extends EventName>(event: E, handler: EventHandler<EventMap[E]>): () => void {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, new Set());
    }
    const handlerSet = this.handlers.get(event)!;
    handlerSet.add(handler as EventHandler<unknown>);

    return () => {
      handlerSet.delete(handler as EventHandler<unknown>);
    };
  }

  /**
   * Publish an event. All handlers run asynchronously.
   * Errors in handlers are logged but do not propagate to the caller.
   */
  async emit<E extends EventName>(event: E, payload: EventMap[E]): Promise<void> {
    const handlerSet = this.handlers.get(event);
    if (!handlerSet || handlerSet.size === 0) {
      return;
    }

    const promises = Array.from(handlerSet).map(async (handler) => {
      try {
        await handler(payload);
      } catch (err) {
        logger.error(
          { err, event, payload },
          `Event handler error for "${String(event)}"`
        );
      }
    });

    await Promise.allSettled(promises);
  }

  /**
   * Remove all handlers (useful for testing).
   */
  removeAllListeners(): void {
    this.handlers.clear();
  }
}

/** Singleton event bus instance */
export const eventBus = new EventBus();
