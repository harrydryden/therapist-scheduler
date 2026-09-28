import { FastifyRequest, FastifyReply } from 'fastify';
import { config } from '../config';
import { logger } from '../utils/logger';
import { HEADERS } from '../constants';
import { Errors } from '../utils/response';
import { cacheManager } from '../utils/redis';
import { safeCompare } from '../utils/hmac-token';

/**
 * FIX R3: Constant-time string comparison to prevent timing attacks.
 * One implementation lives in utils/hmac-token (byte-safe); re-exported
 * here so existing importers keep working.
 */
export { safeCompare };

// FIX H11: Brute force protection configuration
// Threshold raised from 5 to 10: a single admin dashboard page load fires
// multiple concurrent API requests (appointments, stats, detail), so a wrong
// secret easily burns through 5 attempts before the frontend can react.
const AUTH_RATE_LIMIT = {
  MAX_FAILED_ATTEMPTS: 10, // Max failed attempts per window
  WINDOW_SECONDS: 300,     // 5 minute window
  LOCKOUT_SECONDS: 300,    // 5 minute lockout after max attempts
};

// FIX L5: Configurable trusted proxy depth to prevent IP spoofing attacks
// Set TRUSTED_PROXY_DEPTH to the number of trusted proxies in front of the app
// Default: 1 (e.g., Railway/Vercel add one proxy layer)
// If you have multiple load balancers, increase this value
const TRUSTED_PROXY_DEPTH = parseInt(process.env.TRUSTED_PROXY_DEPTH || '1', 10);

// In-memory fallback rate limiter for when Redis is unavailable.
// Capped at MAX_TRACKED_IPS to prevent memory exhaustion from distributed attacks.
const inMemoryAttempts = new Map<string, { count: number; firstAttempt: number }>();
const MAX_TRACKED_IPS = 10000;

function evictExpiredEntries(now: number): void {
  const windowMs = AUTH_RATE_LIMIT.WINDOW_SECONDS * 1000;
  for (const [key, val] of inMemoryAttempts) {
    if (now - val.firstAttempt > windowMs) {
      inMemoryAttempts.delete(key);
    }
  }
}

function checkInMemoryRateLimit(ip: string): { allowed: boolean } {
  const now = Date.now();
  const entry = inMemoryAttempts.get(ip);

  // Periodic cleanup: evict expired entries when map grows large
  if (inMemoryAttempts.size > 100) {
    evictExpiredEntries(now);
  }

  if (!entry || now - entry.firstAttempt > AUTH_RATE_LIMIT.WINDOW_SECONDS * 1000) {
    return { allowed: true };
  }

  return { allowed: entry.count < AUTH_RATE_LIMIT.MAX_FAILED_ATTEMPTS };
}

function recordInMemoryAttempt(ip: string): void {
  const now = Date.now();
  const entry = inMemoryAttempts.get(ip);
  if (!entry || now - entry.firstAttempt > AUTH_RATE_LIMIT.WINDOW_SECONDS * 1000) {
    // Enforce cap: if at capacity after eviction, skip tracking this IP.
    // This is safe because the worst case is allowing an attacker through,
    // which only matters when Redis is already down (degraded mode).
    if (inMemoryAttempts.size >= MAX_TRACKED_IPS) {
      evictExpiredEntries(now);
      if (inMemoryAttempts.size >= MAX_TRACKED_IPS) {
        logger.warn({ mapSize: inMemoryAttempts.size }, 'In-memory rate limiter at capacity — cannot track new IP');
        return;
      }
    }
    inMemoryAttempts.set(ip, { count: 1, firstAttempt: now });
  } else {
    entry.count++;
  }
}

/**
 * Get client IP for rate limiting
 * FIX L5: Only trust the nth-from-right IP in X-Forwarded-For chain
 * This prevents attackers from spoofing their IP by adding fake headers
 */
function getClientIP(request: FastifyRequest): string {
  const forwarded = request.headers['x-forwarded-for'];
  if (typeof forwarded === 'string') {
    const ips = forwarded.split(',').map(ip => ip.trim());
    // Take the (n+1)th IP from the right, where n is the trusted proxy depth
    // This is the IP that was added by the first trusted proxy
    const trustedIndex = Math.max(0, ips.length - TRUSTED_PROXY_DEPTH);
    return ips[trustedIndex] || request.ip || 'unknown';
  }
  return request.ip || 'unknown';
}

/**
 * Check if IP is locked out from auth attempts
 * FIX H11: Prevents brute force attacks on webhook secret
 */
async function checkAuthRateLimit(ip: string): Promise<{ allowed: boolean; retryAfter?: number }> {
  // The in-memory limiter is consulted UNCONDITIONALLY. It is only ever
  // populated while Redis is failing (recordFailedAttempt falls back to it),
  // so when Redis is healthy this is a no-op; when Redis is down it is the
  // only thing standing between an attacker and unlimited guesses.
  const inMemory = checkInMemoryRateLimit(ip);
  if (!inMemory.allowed) {
    return { allowed: false, retryAfter: AUTH_RATE_LIMIT.LOCKOUT_SECONDS };
  }

  try {
    const lockoutKey = `auth:lockout:${ip}`;
    const attemptsKey = `auth:attempts:${ip}`;

    // getStrict, not getString: the lenient wrapper returns null on a Redis
    // error, which used to make the catch below unreachable and the
    // limiter silently fail open during an outage.
    const lockoutUntil = await cacheManager.getStrict(lockoutKey);
    if (lockoutUntil) {
      const remaining = parseInt(lockoutUntil, 10) - Date.now();
      if (remaining > 0) {
        return { allowed: false, retryAfter: Math.ceil(remaining / 1000) };
      }
    }

    // Check attempt count
    const attemptsStr = await cacheManager.getStrict(attemptsKey);
    const attempts = attemptsStr ? parseInt(attemptsStr, 10) : 0;

    if (attempts >= AUTH_RATE_LIMIT.MAX_FAILED_ATTEMPTS) {
      return { allowed: false, retryAfter: AUTH_RATE_LIMIT.LOCKOUT_SECONDS };
    }

    return { allowed: true };
  } catch (err) {
    // Redis unavailable — the in-memory check above already ran.
    logger.error({ err, ip }, 'Redis unavailable for auth rate limiting - using in-memory fallback');
    return { allowed: true };
  }
}

/**
 * Record a failed auth attempt
 */
async function recordFailedAttempt(ip: string): Promise<void> {
  try {
    const attemptsKey = `auth:attempts:${ip}`;
    const lockoutKey = `auth:lockout:${ip}`;

    // Increment attempts (atomic operation)
    const attempts = await cacheManager.incr(attemptsKey);

    // Set TTL on first attempt
    if (attempts === 1) {
      await cacheManager.expire(attemptsKey, AUTH_RATE_LIMIT.WINDOW_SECONDS);
    }

    // If max attempts reached, set lockout
    if (attempts >= AUTH_RATE_LIMIT.MAX_FAILED_ATTEMPTS) {
      const lockoutUntil = Date.now() + AUTH_RATE_LIMIT.LOCKOUT_SECONDS * 1000;
      await cacheManager.set(lockoutKey, lockoutUntil.toString(), AUTH_RATE_LIMIT.LOCKOUT_SECONDS);
      logger.warn({ ip, attempts }, 'Auth rate limit exceeded - IP locked out');
    }
  } catch (err) {
    logger.warn({ err, ip }, 'Failed to record auth attempt to Redis - using in-memory fallback');
    recordInMemoryAttempt(ip);
  }
}

export type AdminSecretCheck =
  | { ok: true }
  | { ok: false; status: 401 }
  | { ok: false; status: 429; retryAfter: number };

/**
 * Validate a candidate admin secret from ANY transport (header, query
 * string) under the brute-force limiter. Shared by the header-based
 * preHandler below and the SSE route, which can only pass the secret as
 * a query parameter and previously skipped the limiter entirely.
 */
export async function checkAdminSecret(
  request: FastifyRequest,
  candidate: unknown,
): Promise<AdminSecretCheck> {
  const ip = getClientIP(request);

  const rateCheck = await checkAuthRateLimit(ip);
  if (!rateCheck.allowed) {
    logger.warn({ requestId: request.id, ip }, 'Auth attempt blocked - rate limited');
    return { ok: false, status: 429, retryAfter: rateCheck.retryAfter ?? AUTH_RATE_LIMIT.LOCKOUT_SECONDS };
  }

  // FIX R3: Use constant-time comparison to prevent timing attacks
  const secretValid =
    typeof candidate === 'string' &&
    !!config.webhookSecret &&
    safeCompare(candidate, config.webhookSecret);

  if (!secretValid) {
    await recordFailedAttempt(ip);
    return { ok: false, status: 401 };
  }
  return { ok: true };
}

/**
 * Verify webhook secret for admin/internal endpoints
 * FIX H11: Added brute force protection
 */
export async function verifyWebhookSecret(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const check = await checkAdminSecret(request, request.headers[HEADERS.WEBHOOK_SECRET]);
  if (check.ok) return;

  if (check.status === 429) {
    reply.header('Retry-After', check.retryAfter.toString());
    return reply.status(429).send({
      success: false,
      error: 'Too many failed authentication attempts. Please try again later.',
    });
  }

  logger.warn({ requestId: request.id }, 'Unauthorized request - invalid webhook secret');
  Errors.unauthorized(reply);
}
