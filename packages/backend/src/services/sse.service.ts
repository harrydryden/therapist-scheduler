/**
 * Server-Sent Events (SSE) Service
 *
 * Provides real-time push updates to the admin dashboard, replacing
 * the 30-second polling interval for status and health changes.
 *
 * Architecture:
 * - Uses Node.js EventEmitter as an in-process event bus
 * - SSE connections subscribe to the bus and forward events to clients
 * - Appointment lifecycle service emits events on status transitions
 * - Heartbeat keeps connections alive through proxies/load balancers
 */

import { EventEmitter } from 'events';
import { FastifyReply } from 'fastify';
import { logger } from '../utils/logger';

// ============================================
// Event Types
// ============================================

export interface SSEAppointmentEvent {
  type: 'appointment:status-changed' | 'appointment:activity' | 'appointment:human-control';
  appointmentId: string;
  data: Record<string, unknown>;
}

export interface SSEStatsEvent {
  type: 'stats:updated';
  data: Record<string, unknown>;
}

export type SSEEvent = SSEAppointmentEvent | SSEStatsEvent;

// ============================================
// Connection Management
// ============================================

interface SSEConnection {
  id: string;
  reply: FastifyReply;
  connectedAt: Date;
}

const MAX_CONNECTIONS = parseInt(process.env.SSE_MAX_CONNECTIONS || '100', 10);
const HEARTBEAT_INTERVAL_MS = 30_000; // 30 seconds

class SSEService {
  private eventBus = new EventEmitter();
  private connections = new Map<string, SSEConnection>();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private connectionCounter = 0;

  constructor() {
    // Increase listener limit since each SSE connection adds a listener
    this.eventBus.setMaxListeners(MAX_CONNECTIONS + 10);
    this.startHeartbeat();
  }

  /**
   * Register a new SSE connection.
   * Sets up the response headers for SSE and subscribes to the event bus.
   */
  addConnection(reply: FastifyReply): string {
    if (this.connections.size >= MAX_CONNECTIONS) {
      logger.warn(
        { current: this.connections.size, max: MAX_CONNECTIONS },
        'SSE connection limit reached, rejecting new connection'
      );
      reply.status(503).send({ error: 'Too many SSE connections' });
      return '';
    }

    const connectionId = `sse-${++this.connectionCounter}-${Date.now().toString(36)}`;

    // Set SSE headers
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no', // Disable nginx buffering
    });

    // Send initial connection event
    this.sendToConnection(reply, {
      type: 'connected',
      connectionId,
    });

    const connection: SSEConnection = {
      id: connectionId,
      reply,
      connectedAt: new Date(),
    };
    this.connections.set(connectionId, connection);

    // Subscribe to events
    const listener = (event: SSEEvent) => {
      this.sendToConnection(reply, event);
    };
    this.eventBus.on('event', listener);

    // Clean up on disconnect
    reply.raw.on('close', () => {
      this.eventBus.off('event', listener);
      this.connections.delete(connectionId);
      logger.debug({ connectionId }, 'SSE connection closed');
    });

    logger.info(
      { connectionId, totalConnections: this.connections.size },
      'SSE connection established'
    );

    return connectionId;
  }

  /**
   * Emit an event to all connected SSE clients.
   */
  emit(event: SSEEvent): void {
    if (this.connections.size === 0) return;
    this.eventBus.emit('event', event);
  }

  /**
   * Emit an appointment status change event.
   */
  emitStatusChange(
    appointmentId: string,
    previousStatus: string,
    newStatus: string,
    source: string
  ): void {
    this.emit({
      type: 'appointment:status-changed',
      appointmentId,
      data: { previousStatus, newStatus, source, timestamp: new Date().toISOString() },
    });
  }

  /**
   * Emit an appointment activity event (new message, tool execution, etc).
   */
  emitActivity(appointmentId: string, activityType: string): void {
    this.emit({
      type: 'appointment:activity',
      appointmentId,
      data: { activityType, timestamp: new Date().toISOString() },
    });
  }

  /**
   * Emit a human control toggle event.
   */
  emitHumanControl(appointmentId: string, enabled: boolean, adminId?: string): void {
    this.emit({
      type: 'appointment:human-control',
      appointmentId,
      data: { enabled, adminId, timestamp: new Date().toISOString() },
    });
  }

  /**
   * Get connection stats for health checks.
   */
  getStats() {
    return {
      activeConnections: this.connections.size,
      maxConnections: MAX_CONNECTIONS,
    };
  }

  private sendToConnection(reply: FastifyReply, data: unknown): void {
    try {
      const payload = `data: ${JSON.stringify(data)}\n\n`;
      reply.raw.write(payload);
    } catch {
      // Connection may have been closed; the 'close' handler will clean up
    }
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      for (const [id, conn] of this.connections) {
        try {
          conn.reply.raw.write(': heartbeat\n\n');
        } catch {
          // Dead connection — remove it
          this.connections.delete(id);
        }
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  stop(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    // Close all connections
    for (const [, conn] of this.connections) {
      try {
        conn.reply.raw.end();
      } catch {
        // Ignore
      }
    }
    this.connections.clear();
  }
}

export const sseService = new SSEService();
