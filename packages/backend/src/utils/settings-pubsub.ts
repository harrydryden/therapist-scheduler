/**
 * Settings invalidation pub/sub
 *
 * Cross-instance memory-cache invalidation for `settings.service`. Without
 * this, an admin updating a setting on instance A clears its own
 * in-memory cache (30 s TTL) and the Redis cache (60 s TTL), but every
 * other instance keeps serving the stale value from its own memory cache
 * for up to 30 s. For ops-critical toggles like `voucher.required` or
 * `general.maxBookingRequestsPerTherapist` that's a real correctness gap.
 *
 * Mechanism:
 *   - `publishSettingsInvalidation(keys)` — called by admin update routes
 *     after the DB upsert. Sends a JSON payload over the
 *     `settings:invalidate` Redis channel via the shared client.
 *   - `subscribeToSettingsInvalidation(handler)` — called once at module
 *     load by settings.service. Opens a dedicated subscriber connection
 *     (ioredis can't issue commands on a subscribed connection, so the
 *     subscriber is a separate socket created via `client.duplicate()`).
 *     Each inbound message dispatches the keys to `handler`.
 *
 * Test-env / Redis-down safe: when `redisClientManager.client` is null
 * (test env, or a connect failure) both publish and subscribe become
 * no-ops. The local memory invalidation already happens inline in the
 * admin route, so single-instance behaviour is unaffected; only the
 * cross-instance fan-out is suppressed.
 */

import type Redis from 'ioredis';
import { redisClientManager } from './redis-client';
import { logger } from './logger';

const CHANNEL = 'settings:invalidate';

interface InvalidationMessage {
  keys: string[];
  // Source instance ID so subscribers can ignore self-publishes if we
  // ever want to. Currently unused: invalidating one's own cache an
  // extra time is a no-op, so no instance-skip logic is needed.
  source?: string;
}

let subscriberConnection: Redis | null = null;
let subscribed = false;

/**
 * Publish a set of setting keys to invalidate across all subscribed
 * instances. No-op when Redis is unavailable.
 */
export async function publishSettingsInvalidation(keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  const client = redisClientManager.client;
  if (!client) return;

  const message: InvalidationMessage = { keys };
  try {
    await client.publish(CHANNEL, JSON.stringify(message));
  } catch (err) {
    // Best-effort: a publish failure means OTHER instances will see the
    // stale cache for up to 30 s. The local instance has already
    // invalidated, so the admin's request still reflects correctly.
    logger.warn({ err, keys }, 'Failed to publish settings invalidation — peers may see stale values briefly');
  }
}

/**
 * Subscribe to settings-invalidation messages and dispatch each batch's
 * keys to `handler`. Idempotent: only the first call opens the
 * subscriber; further calls are no-ops.
 */
export function subscribeToSettingsInvalidation(handler: (keys: string[]) => void): void {
  if (subscribed) return;
  const baseClient = redisClientManager.client;
  if (!baseClient) {
    // Test env or Redis unavailable at startup. The subscriber stays
    // dormant — single-instance / test behaviour is unaffected because
    // local memory invalidation still runs inline in the admin route.
    return;
  }

  let conn: Redis;
  try {
    conn = baseClient.duplicate();
  } catch (err) {
    logger.warn({ err }, 'Failed to duplicate Redis client for settings subscriber — cross-instance invalidation disabled');
    return;
  }
  subscriberConnection = conn;
  subscribed = true;

  conn.on('error', (err) => {
    logger.warn({ err }, 'Settings invalidation subscriber error');
  });

  conn.subscribe(CHANNEL, (err) => {
    if (err) {
      logger.warn({ err, channel: CHANNEL }, 'Failed to subscribe to settings invalidation channel');
      subscribed = false;
      return;
    }
    logger.info({ channel: CHANNEL }, 'Subscribed to settings invalidation');
  });

  conn.on('message', (channel, raw) => {
    if (channel !== CHANNEL) return;
    try {
      const parsed = JSON.parse(raw) as InvalidationMessage;
      if (!parsed || !Array.isArray(parsed.keys)) return;
      handler(parsed.keys);
    } catch (err) {
      logger.warn({ err, raw }, 'Malformed settings invalidation message — ignoring');
    }
  });
}

/**
 * Test-only teardown — closes the subscriber connection. Production code
 * doesn't need this; the connection lives for the process lifetime.
 */
export async function _resetSettingsPubsubForTests(): Promise<void> {
  if (subscriberConnection) {
    try {
      await subscriberConnection.quit();
    } catch {
      // ignore — fresh test runs may have already closed it
    }
    subscriberConnection = null;
  }
  subscribed = false;
}
