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

import crypto from 'crypto';
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
  /** Event listener reference — needed to remove from EventEmitter on cleanup */
  listener: (event: SSEEvent) => void;
}

const MAX_CONNECTIONS = parseInt(process.env.SSE_MAX_CONNECTIONS || '100', 10);
const HEARTBEAT_INTERVAL_MS = 30_000; // 30 seconds

// ============================================
// Connection tickets
// ============================================
//
// EventSource can't send headers, so the dashboard used to put the admin
// secret itself in the stream URL (?secret=…), where it ends up in proxy
// logs and browser history. Instead an authenticated POST mints a random
// ticket that opens ONE stream within 60 seconds. Tickets are stored
// hashed (a Redis dump holds nothing usable) in Redis so any instance can
// redeem them, with an in-process fallback while Redis is unavailable.

export const SSE_TICKET_TTL_SECONDS = 60;
const TICKET_KEY_PREFIX = 'sse:ticket:';
const TICKET_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;
const SET_TICKET = "return redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])";
const CONSUME_TICKET = "local v = redis.call('GET', KEYS[1]) if v then redis.call('DEL', KEYS[1]) end return v";

// Loaded on first use so importing the SSE bus (which half the services
// do, for emit*) doesn't pull in the Redis client and its config.
async function redisCache() {
  return (await import('../utils/redis')).cacheManager;
}

function ticketKey(ticket: string): string {
  return TICKET_KEY_PREFIX + crypto.createHash('sha256').update(ticket).digest('hex');
}

class SSEService {
  private eventBus = new EventEmitter();
  private connections = new Map<string, SSEConnection>();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private connectionCounter = 0;
  /** Tickets minted while Redis was unavailable: key → expiry (ms). */
  private memoryTickets = new Map<string, number>();

  /**
   * Mint a single-use ticket that authorises one SSE connection for
   * SSE_TICKET_TTL_SECONDS. Callers must already be authenticated.
   */
  async issueTicket(): Promise<{ ticket: string; expiresInSeconds: number }> {
    const ticket = crypto.randomBytes(32).toString('base64url');
    const key = ticketKey(ticket);
    try {
      await (await redisCache()).eval(SET_TICKET, 1, key, '1', SSE_TICKET_TTL_SECONDS);
    } catch (err) {
      logger.warn({ err }, 'SSE ticket: Redis unavailable, keeping ticket in memory');
      this.pruneMemoryTickets();
      this.memoryTickets.set(key, Date.now() + SSE_TICKET_TTL_SECONDS * 1000);
    }
    return { ticket, expiresInSeconds: SSE_TICKET_TTL_SECONDS };
  }

  /**
   * Redeem a ticket. True exactly once per ticket, and only within its
   * lifetime; any malformed, unknown, expired or reused ticket is false.
   */
  async consumeTicket(ticket: unknown): Promise<boolean> {
    if (typeof ticket !== 'string' || !TICKET_PATTERN.test(ticket)) return false;
    const key = ticketKey(ticket);

    const memoryExpiry = this.memoryTickets.get(key);
    if (memoryExpiry !== undefined) {
      this.memoryTickets.delete(key);
      return memoryExpiry > Date.now();
    }
    try {
      const value = await (await redisCache()).eval(CONSUME_TICKET, 1, key);
      return value !== null && value !== undefined;
    } catch (err) {
      logger.warn({ err }, 'SSE ticket: Redis unavailable while redeeming ticket');
      return false;
    }
  }

  private pruneMemoryTickets(): void {
    const now = Date.now();
    for (const [key, expiresAt] of this.memoryTickets) {
      if (expiresAt <= now) this.memoryTickets.delete(key);
    }
  }

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

    // Subscribe to events
    const listener = (event: SSEEvent) => {
      this.sendToConnection(reply, event);
    };
    this.eventBus.on('event', listener);

    const connection: SSEConnection = {
      id: connectionId,
      reply,
      connectedAt: new Date(),
      listener,
    };
    this.connections.set(connectionId, connection);

    // Clean up on disconnect
    reply.raw.on('close', () => {
      this.removeConnection(connectionId);
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

  /**
   * Remove a connection and its EventEmitter listener.
   * Called from both the 'close' handler and heartbeat dead-connection cleanup.
   */
  private removeConnection(connectionId: string): void {
    const conn = this.connections.get(connectionId);
    if (!conn) return;
    this.eventBus.off('event', conn.listener);
    this.connections.delete(connectionId);
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
        const socket = conn.reply.raw;
        // Proactively detect sockets the OS has closed under us — `write`
        // on a destroyed/ended stream returns false rather than throwing,
        // which the catch below would miss. Without this check, dead
        // connections accumulate against the MAX_CONNECTIONS cap until a
        // write actually errors (which it may never do).
        if (socket.destroyed || socket.writableEnded || !socket.writable) {
          this.removeConnection(id);
          continue;
        }
        try {
          socket.write(': heartbeat\n\n');
        } catch {
          // Dead connection — remove it and its EventEmitter listener
          this.removeConnection(id);
        }
      }
    }, HEARTBEAT_INTERVAL_MS);
    // Never keep the process alive on its own (tests, graceful shutdown).
    this.heartbeatTimer.unref?.();
  }

  stop(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    // Close all connections and remove their EventEmitter listeners
    for (const [, conn] of this.connections) {
      this.eventBus.off('event', conn.listener);
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
